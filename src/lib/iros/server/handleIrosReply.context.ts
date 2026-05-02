// file: src/lib/iros/server/handleIrosReply.context.ts
// iros - Turn context builder (minimal + frame plan)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';

import { loadBaseMetaFromMemoryState } from './handleIrosReply.state';
import { loadLatestIrDiagnosisSnapshot } from '@/lib/iros/memoryRecall';

// ✅ FramePlan（器＋スロット）(Layer C/D)
import { buildFramePlan, type InputKind, type IrosStateLite } from '@/lib/iros/language/frameSlots';

// ✅ 外部conversationId(string) -> DB conversation_id(uuid) 変換
import { ensureIrosConversationUuid } from './ensureIrosConversationUuid';

function normOptString(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return s.length > 0 ? s : undefined;
}

export type BuildTurnContextArgs = {
  supabase: SupabaseClient;
  conversationId: string;
  userCode: string;
  text: string;
  mode: string;
  traceId?: string | null;
  userProfile?: IrosUserProfileRow | null;
  requestedStyle: IrosStyle | string | null;

  // ✅ optional: caller may pass history (future use)
  history?: unknown[];

  // ✅ route.ts / caller から明示的に渡す “希望”
  // - NextStep choice 等から来る requestedDepth/requestedQCode はここに入れる
  requestedDepth?: string | null;
  requestedQCode?: string | null;
};

export type TurnContext = {
  isFirstTurn: boolean;

  // orchestrator に渡す
  requestedMode: string | undefined;
  requestedDepth: string | undefined;
  requestedQCode: string | undefined;

  baseMetaForTurn: any;

  // style
  effectiveStyle: IrosStyle | string | null;

  // 最終モードのフォールバックに使える
  finalMode: string | null;

  // ✅ downstream の digest / recall / state cues 用
  lastUserCore: string;
  lastAssistantCore: string;
  situationSummary: string;
  situationTopic: string;
  continuity: {
    last_user_core: string;
    last_assistant_core: string;
  };
};

async function resolveIsFirstTurn(
  supabase: SupabaseClient,
  userCode: string,
  conversationId: string,
): Promise<boolean> {
  try {
    // ✅ uuid列に外部キー文字列を突っ込まない
    const conversationUuid = await ensureIrosConversationUuid({
      supabase,
      userCode,
      conversationKey: String(conversationId ?? '').trim(),
      agent: null,
    });

    const { data, error } = await supabase
      .from('iros_messages')
      .select('id')
      .eq('conversation_id', conversationUuid)
      .limit(1);

    if (error) {
      console.error('[IROS/Context] resolveIsFirstTurn select failed', {
        conversationId,
        conversationUuid,
        error,
      });
      return false;
    }

    return (data?.length ?? 0) === 0;
  } catch (e) {
    console.error('[IROS/Context] resolveIsFirstTurn unexpected', {
      conversationId,
      error: e,
    });
    return false;
  }
}

/* =========================
   Helpers: InputKind detector (LLM禁止・純関数)
========================= */
function detectInputKind(userText: string): InputKind {
  const s = String(userText ?? '').trim();
  if (!s) return 'unknown';

  // ✅ recall-check（会話を覚えてる？系）: 質問扱いにすると frame=R でテンプレ化しやすいので chat 扱いに落とす
  if (
    /(覚えて(る|ます)|覚えてますか|覚えてる\?|覚えてる？)/.test(s) &&
    /(話|こと|件|それ|この件|前|さっき|昨日|先週|会社)/.test(s)
  ) {
    return 'chat';
  }

  if (/(達成|サマリ|進捗|振り返り|まとめ|総括|レビュー|できたこと|やったこと)/.test(s)) {
    return 'review';
  }

  if (
    /(実装|修正|改修|デバッグ|バグ|エラー|ログ|原因|再現|調査|確認|設計|仕様|コード|関数|ファイル|import|export|tsc|typecheck|TypeScript|Next\.js|Supabase|SQL)/i.test(
      s,
    )
  ) {
    return 'task';
  }

  // question という InputKind は廃止（PDF: 4分類へ収束）
  // - 末尾「?」や疑問語は “chat内の性質” として slot/contract で扱う
  if (/[?？]$/.test(s) || /(なに|何|どこ|いつ|だれ|誰|なぜ|どうして|どうやって)/.test(s)) {
    return 'chat';
  }

  return 'chat';
}

export async function buildTurnContext(
  args: BuildTurnContextArgs,
): Promise<TurnContext> {
  const {
    supabase,
    conversationId,
    userCode,
    mode,
    requestedStyle,
    userProfile,
    text,
  } = args;

  // ✅ ここだけ変更：uuid解決経由で firstTurn 判定
  const isFirstTurn = await resolveIsFirstTurn(supabase, userCode, conversationId);

  const styleFromProfile =
    userProfile && typeof (userProfile as any).style === 'string'
      ? ((userProfile as any).style as string)
      : null;

  const effectiveStyle =
    (requestedStyle &&
    typeof requestedStyle === 'string' &&
    requestedStyle.trim().length > 0
      ? requestedStyle
      : null) ??
    styleFromProfile ??
    null;

  const requestedMode = mode === 'auto' ? undefined : mode;

  // ✅ caller/route から来た “希望” をここで確定させて ctx に渡す
  // - 空文字は undefined 扱い
  const requestedDepth = normOptString(
    (args as any)?.requestedDepth ?? (args as any)?.requested_depth,
  );
  const requestedQCode = normOptString(
    (args as any)?.requestedQCode ??
      (args as any)?.requested_q_code ??
      (args as any)?.requested_qcode,
  );

  // base meta
  let baseMetaForTurn: any = {};
  if (effectiveStyle) baseMetaForTurn.style = effectiveStyle;

  // ✅ MemoryState を読み、baseMeta に合成（depth / qCode / selfAcceptance / y/h / spin）
  const loaded = await loadBaseMetaFromMemoryState({
    sb: supabase,
    userCode,
    baseMeta: baseMetaForTurn,
  } as any);

  // ★ depthStage を camelCase に寄せる（下流の取りこぼし防止）
  {
    const depthStage =
      baseMetaForTurn?.depthStage ??
      baseMetaForTurn?.depth_stage ??
      baseMetaForTurn?.depth ??
      null;

    if (typeof depthStage === 'string' && depthStage.trim().length > 0) {
      baseMetaForTurn.depthStage = depthStage.trim();
    }
  }

  const mergedBaseMeta = (loaded as any)?.mergedBaseMeta;
  const memoryState = (loaded as any)?.memoryState ?? (loaded as any)?.state ?? null;

  baseMetaForTurn = mergedBaseMeta ?? baseMetaForTurn;

  // =========================================================
  // ✅ depth_stage を “必ず” baseMetaForTurn のトップに同期する
  // =========================================================
  {
    const depthStageFromMemory =
      (typeof memoryState?.depthStage === 'string' && String(memoryState.depthStage).trim()) ||
      (typeof memoryState?.depth_stage === 'string' && String(memoryState.depth_stage).trim()) ||
      null;

    const depthStageTop =
      (typeof baseMetaForTurn?.depth_stage === 'string' && String(baseMetaForTurn.depth_stage).trim()) ||
      (typeof baseMetaForTurn?.depthStage === 'string' && String(baseMetaForTurn.depthStage).trim()) ||
      (typeof baseMetaForTurn?.depth === 'string' && String(baseMetaForTurn.depth).trim()) ||
      depthStageFromMemory ||
      null;

    if (depthStageTop) {
      baseMetaForTurn.depth_stage = depthStageTop;
      baseMetaForTurn.depthStage = depthStageTop;
      if (!baseMetaForTurn.depth) baseMetaForTurn.depth = depthStageTop;
    }
  }

  // ★ spin/descent を camelCase に寄せる（下流の取りこぼし防止）
  const spinLoop =
    baseMetaForTurn?.spinLoop ??
    baseMetaForTurn?.spin_loop ??
    (baseMetaForTurn?.rotationState?.spinLoop ?? null) ??
    null;

  const spinStep =
    typeof baseMetaForTurn?.spinStep === 'number'
      ? baseMetaForTurn.spinStep
      : typeof baseMetaForTurn?.spin_step === 'number'
        ? baseMetaForTurn.spin_step
        : typeof baseMetaForTurn?.rotationState?.spinStep === 'number'
          ? baseMetaForTurn.rotationState.spinStep
          : null;

  const descentGate =
    baseMetaForTurn?.descentGate ??
    baseMetaForTurn?.descent_gate ??
    (baseMetaForTurn?.rotationState?.descentGate ?? null) ??
    null;

  if (spinLoop) baseMetaForTurn.spinLoop = spinLoop;
  if (typeof spinStep === 'number') baseMetaForTurn.spinStep = spinStep;
  if (descentGate) baseMetaForTurn.descentGate = descentGate;

  // ★ phase を baseMetaForTurn に注入（pivot 判定のため必須）
  {
    const phase =
      baseMetaForTurn?.phase ??
      baseMetaForTurn?.phase_raw ??
      baseMetaForTurn?.phaseStage ??
      null;

    if (phase) baseMetaForTurn.phase = phase;
  }

  // ✅ FramePlan を作って baseMeta に入れる（Layer C/D の入口）
  try {
    const inputKind = detectInputKind(text);
    const healthReportKind = (() => {
      const s = String(text ?? '').trim();
      if (!s) return null as 'initial' | 'recovery' | 'continuing' | null;

      if (/(構造|意味|診断|どういう|なぜ|原因|修正|実装|コード|SQL|ログ)/.test(s)) {
        return null as 'initial' | 'recovery' | 'continuing' | null;
      }

      const hasInitialHealthSignal =
        /(熱|発熱|高熱|微熱|38度|３８度|39度|３９度|体調|しんどい|だるい|寒気|頭痛|咳|喉|喉が痛い|寝込|病院|風邪|インフル|コロナ|寒い|寒かった|冷え|冷える|震える|震え|ストーブ|暖房)/.test(s);

      const hasRecoverySignal =
        /(治った|治りました|治って|治り|下がった|下がりました|落ち着いた|落ち着きました|回復|良くなった|よくなった|大丈夫|問題ない|平気)/.test(s);

      const hasContinuingSignal =
        /(まだ|続いて|続く|残って|残る|ぶり返|治らない|下がらない|しんどい|だるい|きつい|寒い|冷える|震える|震え)/.test(s) &&
        /(熱|発熱|体調|だるさ|寒気|頭痛|咳|喉|風邪|インフル|コロナ|寒い|寒かった|冷え|冷える|震える|震え|ストーブ|暖房)/.test(s);

      if (hasContinuingSignal) return 'continuing';
      if (hasRecoverySignal) return 'recovery';
      if (hasInitialHealthSignal) return 'initial';

      return null as 'initial' | 'recovery' | 'continuing' | null;
    })();

    const healthReport = healthReportKind !== null;

    if (healthReport) {
      (baseMetaForTurn as any).extra =
        (baseMetaForTurn as any).extra && typeof (baseMetaForTurn as any).extra === 'object'
          ? (baseMetaForTurn as any).extra
          : {};

      (baseMetaForTurn as any).extra.ctxPack =
        (baseMetaForTurn as any).extra.ctxPack &&
        typeof (baseMetaForTurn as any).extra.ctxPack === 'object'
          ? (baseMetaForTurn as any).extra.ctxPack
          : {};

      (baseMetaForTurn as any).extra.healthReport = true;
      (baseMetaForTurn as any).extra.healthReportKind = healthReportKind;
      (baseMetaForTurn as any).extra.ctxPack.healthReport = true;
      (baseMetaForTurn as any).extra.ctxPack.healthReportKind = healthReportKind;
      (baseMetaForTurn as any).extra.ctxPack.casualReportKind =
        healthReportKind === 'recovery'
          ? 'health_recovery'
          : healthReportKind === 'continuing'
            ? 'health_continuing'
            : 'health_initial';
    }
    // =========================
    // ✅ Concept Lock (RECALL hint)
    // =========================
    const userTextNow = String(text ?? '').trim();
    const ex0: any =
      (baseMetaForTurn as any)?.extra && typeof (baseMetaForTurn as any).extra === 'object'
        ? (baseMetaForTurn as any).extra
        : null;

    const cl0: any = ex0?.conceptLock ?? null;
    const clItems: string[] | null =
      cl0 && typeof cl0 === 'object' && cl0.active === true && Array.isArray(cl0.items)
        ? cl0.items.filter(Boolean).map((s: any) => String(s ?? '').trim()).filter(Boolean)
        : null;

    const wantsRecall =
      !!userTextNow &&
      /(３つ|三つ|3つ|その3つ|この3つ|それ|それは|あれ|あれは|何ですか|なんですか|って何)/.test(userTextNow);

    if (wantsRecall && clItems && clItems.length >= 3) {
      if (!(baseMetaForTurn as any).extra || typeof (baseMetaForTurn as any).extra !== 'object') {
        (baseMetaForTurn as any).extra = {};
      }
      const ex: any = (baseMetaForTurn as any).extra;

      if (ex.conceptRecall == null) {
        ex.conceptRecall = {
          active: true,
          items: clItems.slice(0, 3),
          at: Date.now(),
          reason: 'USER_REF',
        };
      }

      // ✅ LLM seed（上書き禁止）
      if (typeof ex.llmRewriteSeed !== 'string' || !ex.llmRewriteSeed.trim()) {
        ex.llmRewriteSeed =
          `概念固定：「3つ」は ${clItems.slice(0, 3).join(' / ')}。この3つを否認せず、先に定義を明示してから説明する。`;
      }

      console.log('[IROS/CONCEPT_LOCK][RECALL_HINT]', {
        inputKind,
        items: clItems.slice(0, 3),
        userHead: userTextNow.slice(0, 80),
        hasSeed: typeof ex.llmRewriteSeed === 'string' && !!ex.llmRewriteSeed.trim(),
      });
    }

    // IrosStateLite は型が変動しやすいので “必要最小” を寄せて any で通す
    const stateLite: IrosStateLite = {
      depthStage:
        baseMetaForTurn?.depthStage ??
        baseMetaForTurn?.depth_stage ??
        baseMetaForTurn?.depth ??
        null,

      qPrimary:
        baseMetaForTurn?.qPrimary ??
        baseMetaForTurn?.q_primary ??
        baseMetaForTurn?.q_code ??
        baseMetaForTurn?.qCode ??
        null,

      selfAcceptance:
        typeof baseMetaForTurn?.selfAcceptance === 'number'
          ? baseMetaForTurn.selfAcceptance
          : typeof baseMetaForTurn?.self_acceptance === 'number'
            ? baseMetaForTurn.self_acceptance
            : null,

      phase: baseMetaForTurn?.phase ?? null,

      intentLayer:
        baseMetaForTurn?.intentLayer ??
        baseMetaForTurn?.intent_layer ??
        null,

      spinStep: typeof spinStep === 'number' ? spinStep : null,
      descentGate: descentGate ?? null,
    } as any;

    const isIrDiagnosisTurn =
    mode === 'ir' ||
    mode === 'diagnosis' ||
    (baseMetaForTurn as any)?.extra?.isIrDiagnosisTurn === true ||
    (baseMetaForTurn as any)?.presentationKind === 'diagnosis';

  // 🔥 詳細要求検知
  const detailSourceText = String(
    (baseMetaForTurn as any)?.userText ??
      (baseMetaForTurn as any)?.inputText ??
      (baseMetaForTurn as any)?.text ??
      ''
  );

  const wantsDetail = /詳しく|詳細|もう少し|深く/.test(detailSourceText);

  // 🔥 前回 irMeta 取得
  const prevIrMeta =
    (baseMetaForTurn as any)?.prevMeta?.extra?.irMeta ??
    (baseMetaForTurn as any)?.prevMeta?.extra?.ctxPack?.irMeta ??
    (baseMetaForTurn as any)?.prevMeta?.ctxPack?.irMeta ??
    null;

  const prevDetailMode =
    (baseMetaForTurn as any)?.prevMeta?.extra?.detailMode === true ||
    (baseMetaForTurn as any)?.prevMeta?.extra?.ctxPack?.detailMode === true ||
    (baseMetaForTurn as any)?.prevMeta?.ctxPack?.detailMode === true;

  // 🔥 診断 followup 判定
  const followupSourceText = detailSourceText.trim();

  const isFollowupRequest =
    /具体的に|わかりやすく|分かりやすく|つまり|どういうこと|それって|どうすれば|何をすれば|続き|言い換えて|言い換え|翻訳して|翻訳|簡単に|一言で|もう少し深く|その理由|なぜそうなる/.test(
      followupSourceText
    );

  // 🔶 先に DB 側の最新診断 snapshot を読む
  // いままでは isDiagnosisFollowup が true の時しか読まなかったため、
  // prevIrMeta が null のケースで永久に発火しない循環になっていた
  let lastIrDiagnosis: any = null;

  if (!isIrDiagnosisTurn && isFollowupRequest) {
    try {
      lastIrDiagnosis = await loadLatestIrDiagnosisSnapshot(supabase, userCode);
    } catch (e) {
      console.warn('[IROS][diagnosisFollowup] load failed', e);
    }
  }

  const hasDiagnosisSource = !!prevIrMeta || !!lastIrDiagnosis;

  const isDiagnosisFollowup =
    !isIrDiagnosisTurn &&
    hasDiagnosisSource &&
    isFollowupRequest;

  const diagnosisFollowupKind: 'concretize' | 'action' | 'rephrase' | 'deepen' | null =
    !isDiagnosisFollowup
      ? null
      : /どうすれば|何をすれば|次は|どう動く/.test(followupSourceText)
        ? 'action'
        : /言い換えて|言い換え|翻訳して|翻訳|簡単に|一言で|わかりやすく|分かりやすく|つまり|どういうこと/.test(followupSourceText)
          ? 'rephrase'
          : /もう少し深く|その理由|なぜそうなる/.test(followupSourceText)
            ? 'deepen'
            : 'concretize';

  // 🔥 履歴ベース再診断フラグ
  const isDiagnosisDetailTurn =
    !isIrDiagnosisTurn &&
    !isDiagnosisFollowup &&
    wantsDetail &&
    hasDiagnosisSource;

  if (isDiagnosisFollowup || isDiagnosisDetailTurn) {
    (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
    (baseMetaForTurn as any).extra.ctxPack =
      (baseMetaForTurn as any).extra.ctxPack ?? {};

      const lastIrDiagnosisResolved =
      lastIrDiagnosis ??
      (prevIrMeta
        ? {
            target:
              String((prevIrMeta as any)?.targetLabel ?? '').trim() || null,
            observation:
              String((prevIrMeta as any)?.observationResult ?? '').trim() || null,
            state:
              String((prevIrMeta as any)?.awarenessText ?? '').trim() || null,
            summary:
              String((prevIrMeta as any)?.summaryText ?? '').trim() || null,
            createdAt: null,
          }
        : null);

    const normalizedIrMeta =
      prevIrMeta ??
      (lastIrDiagnosisResolved
        ? {
            targetLabel:
              String((lastIrDiagnosisResolved as any)?.target ?? '').trim() || null,
            observationResult:
              String((lastIrDiagnosisResolved as any)?.observation ?? '').trim() || null,
            awarenessText:
              String((lastIrDiagnosisResolved as any)?.state ?? '').trim() || null,
            summaryText:
              String((lastIrDiagnosisResolved as any)?.summary ?? '').trim() || null,
          }
        : null);

    (baseMetaForTurn as any).extra.isIrDiagnosisTurn = true;
    (baseMetaForTurn as any).extra.irMeta = normalizedIrMeta;
    (baseMetaForTurn as any).extra.ctxPack.irMeta = normalizedIrMeta;
    if (lastIrDiagnosisResolved) {
      (baseMetaForTurn as any).extra.lastIrDiagnosis = lastIrDiagnosisResolved;
      (baseMetaForTurn as any).extra.ctxPack.lastIrDiagnosis = lastIrDiagnosisResolved;
    }

    if (isDiagnosisDetailTurn) {
      (baseMetaForTurn as any).extra.detailMode = true;
      (baseMetaForTurn as any).extra.ctxPack.detailMode =
        prevDetailMode || true;
    }

    if (isDiagnosisFollowup) {
      if (lastIrDiagnosisResolved) {
        (baseMetaForTurn as any).extra.lastIrDiagnosis = lastIrDiagnosisResolved;
        (baseMetaForTurn as any).extra.ctxPack.lastIrDiagnosis = lastIrDiagnosisResolved;

        const diagnosisText =
          lastIrDiagnosisResolved.summary ??
          lastIrDiagnosisResolved.observation ??
          lastIrDiagnosisResolved.state ??
          lastIrDiagnosisResolved.target ??
          null;

        if (diagnosisText) {
          (baseMetaForTurn as any).extra.ctxPack.topicHint = diagnosisText;
        }
      }

      const diagnosisTopicHint =
        lastIrDiagnosisResolved?.summary ??
        lastIrDiagnosisResolved?.observation ??
        lastIrDiagnosisResolved?.state ??
        lastIrDiagnosisResolved?.target ??
        null;

      const resolvedFollowupKind =
        diagnosisFollowupKind ?? 'concretize';

      (baseMetaForTurn as any).extra.diagnosisFollowup = true;
      (baseMetaForTurn as any).extra.followupKind = resolvedFollowupKind;

      (baseMetaForTurn as any).extra.ctxPack.diagnosisFollowup = true;
      (baseMetaForTurn as any).extra.ctxPack.followupKind = resolvedFollowupKind;
      (baseMetaForTurn as any).extra.ctxPack.continuityKind =
        'diagnosis_followup';
      (baseMetaForTurn as any).extra.ctxPack.topicHint = diagnosisTopicHint;
      (baseMetaForTurn as any).extra.ctxPack.goalKind =
        resolvedFollowupKind === 'action' ? 'action' : 'clarify';

      // followup では「ユーザーの短文」ではなく「直前診断」を正本化する
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        diagnosisTopicHint;
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        lastIrDiagnosisResolved?.target ?? diagnosisTopicHint;

      // 通常 question 文脈への吸い込みを弱める
      (baseMetaForTurn as any).extra.ctxPack.question = null;
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = {
        kind: resolvedFollowupKind === 'action' ? 'action' : 'clarify',
      };
    }

      (baseMetaForTurn as any).presentationKind = 'diagnosis';
      (baseMetaForTurn as any).mode = 'diagnosis';
    }
  const framePlan =
    isIrDiagnosisTurn || isDiagnosisDetailTurn
      ? null
      : buildFramePlan({ state: stateLite, inputKind });

  baseMetaForTurn.inputKind = inputKind;

  if (!(isIrDiagnosisTurn || isDiagnosisDetailTurn) && framePlan) {
    baseMetaForTurn.framePlan = framePlan;
  } else {
    delete (baseMetaForTurn as any).framePlan;
  }

    // =========================
    // ✅ FINAL pre-seed（writer前に seed を必ず用意）
    // - raw userText は入れない
    // - 既に llmRewriteSeed がある場合は上書きしない
    // - “観測: [USER]” のような「入力なし誤解」ワードは一切入れない（地雷除去）
    // =========================
    try {
      if (!(baseMetaForTurn as any).extra || typeof (baseMetaForTurn as any).extra !== 'object') {
        (baseMetaForTurn as any).extra = {};
      }
      const ex: any = (baseMetaForTurn as any).extra;

      const policyNow: string =
        String(
          (baseMetaForTurn as any)?.framePlan?.slotPlanPolicy ??
            (baseMetaForTurn as any)?.slotPlanPolicy ??
            '',
        )
          .trim()
          .toUpperCase();

      if (policyNow === 'FINAL' && (typeof ex.llmRewriteSeed !== 'string' || !ex.llmRewriteSeed.trim())) {
        const depthNow =
          (baseMetaForTurn as any)?.depthStage ??
          (baseMetaForTurn as any)?.depth_stage ??
          (baseMetaForTurn as any)?.depth ??
          null;

        const qNow =
          (baseMetaForTurn as any)?.qPrimary ??
          (baseMetaForTurn as any)?.q_primary ??
          (baseMetaForTurn as any)?.q_code ??
          (baseMetaForTurn as any)?.qCode ??
          null;

        // ✅ “userMasked=true” は「入力があるが伏字」を示す構造フラグ（誤解防止）
        ex.llmRewriteSeed = [
          'FINAL_SEED_V0 (DO NOT OUTPUT)',
          `inputKind=${String((baseMetaForTurn as any)?.inputKind ?? inputKind ?? '').trim() || 'unknown'}`,
          `coord=depth:${depthNow ?? 'null'} q:${qNow ?? 'null'}`,
          'userMasked=true',
          'view=1つだけ（解釈を増やしすぎない）',
          'next=1つだけ（小さく）',
          'safe=1行（押しつけない）',
        ].join('\n');

        ex.llmRewriteSeedFrom = ex.llmRewriteSeedFrom ?? 'context(FINAL_preseed)';
        ex.llmRewriteSeedAt = ex.llmRewriteSeedAt ?? new Date().toISOString();

        console.log('[IROS/CONTEXT][FINAL_PRESEED]', {
          inputKind,
          policyNow,
          hasSeed: true,
          seedLen: ex.llmRewriteSeed.length,
          seedHead: String(ex.llmRewriteSeed).slice(0, 96),
        });
      }
    } catch (e) {
      console.warn('[IROS/CONTEXT][FINAL_PRESEED][FAILED]', { error: e });
    }

    console.log('[IROS/Context] framePlan built', {
      userCode: (stateLite as any)?.userCode ?? null,
      inputKind,
      frame: (framePlan as any)?.frame ?? null,

      hasSlots: Array.isArray((framePlan as any)?.slots) && (framePlan as any).slots.length > 0,

      spinLoop: (stateLite as any)?.spinLoop ?? null,
      descentGate: (stateLite as any)?.descentGate ?? null,
      depthStage: (stateLite as any)?.depthStage ?? null,
      phase: (stateLite as any)?.phase ?? null,

      requestedDepth: (baseMetaForTurn as any)?.requestedDepth ?? null,
      requestedQCode: (baseMetaForTurn as any)?.requestedQCode ?? null,

      slots_isArray: Array.isArray((framePlan as any)?.slots),
      slots_len: Array.isArray((framePlan as any)?.slots) ? (framePlan as any).slots.length : null,

      slots_samples: Array.isArray((framePlan as any)?.slots)
        ? (framePlan as any).slots.slice(0, 4).map((s: any, i: number) => ({
            i,
            type: typeof s,
            isNull: s === null,
            isObj: !!s && typeof s === 'object',
            keys: s && typeof s === 'object' ? Object.keys(s) : null,

            key: s?.key ?? s?.slotKey ?? s?.k ?? null,
            kind: s?.kind ?? s?.type ?? null,

            contentHead: String(s?.content ?? '').replace(/\s+/g, ' ').slice(0, 140),
            textHead: String(s?.text ?? '').replace(/\s+/g, ' ').slice(0, 140),
            promptHead: String(s?.prompt ?? '').replace(/\s+/g, ' ').slice(0, 140),

            jsonHead: (() => {
              try {
                const j = JSON.stringify(s);
                return j ? j.slice(0, 300) : '';
              } catch {
                return '(jsonify_failed)';
              }
            })(),
          }))
        : null,

      slots_heads: Array.isArray((framePlan as any)?.slots)
        ? (framePlan as any).slots.map((s: any) => ({
            key: s?.key ?? s?.slotKey ?? s?.k ?? null,
            head: String(s?.content ?? s?.text ?? s?.prompt ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 160),
          }))
        : null,
    });
  } catch (e) {
    console.warn('[IROS/Context] framePlan build failed', e);
  }

  const latestUserCore = String(text ?? '').trim().slice(0, 120);

  const latestAssistantCore =
    typeof (baseMetaForTurn as any)?.lastAssistantCore === 'string'
      ? String((baseMetaForTurn as any).lastAssistantCore).trim().slice(0, 120)
      : '';

  const rawSituationSummary =
    typeof (memoryState as any)?.situationSummary === 'string'
      ? String((memoryState as any).situationSummary).trim()
      : typeof (baseMetaForTurn as any)?.situationSummary === 'string'
        ? String((baseMetaForTurn as any).situationSummary).trim()
        : '';

  const rawSituationTopic =
    typeof (memoryState as any)?.situationTopic === 'string'
      ? String((memoryState as any).situationTopic).trim()
      : typeof (baseMetaForTurn as any)?.situationTopic === 'string'
        ? String((baseMetaForTurn as any).situationTopic).trim()
        : '';

  const isGenericTopic =
    !rawSituationTopic ||
    rawSituationTopic === 'その他・ライフ全般' ||
    rawSituationTopic === 'その他ライフ全般' ||
    rawSituationTopic === 'ライフ全般' ||
    rawSituationTopic === 'その他';

  const finalSituationSummary = (rawSituationSummary || latestUserCore).slice(0, 120);
  const finalSituationTopic = (
    isGenericTopic
      ? (finalSituationSummary || latestUserCore || 'その他・ライフ全般')
      : rawSituationTopic
  ).slice(0, 40);

  return {
    isFirstTurn,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMetaForTurn,
    effectiveStyle,
    finalMode: mode ?? null,

    lastUserCore: latestUserCore,
    lastAssistantCore: latestAssistantCore,
    situationSummary: finalSituationSummary,
    situationTopic: finalSituationTopic,
    continuity: {
      last_user_core: latestUserCore,
      last_assistant_core: latestAssistantCore,
    },
  };
}
