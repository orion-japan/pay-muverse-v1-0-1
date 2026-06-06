// file: src/lib/iros/server/handleIrosReply.context.ts
// iros - Turn context builder (minimal + frame plan)

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import type { IrosUserProfileRow } from './loadUserProfile';

import { loadBaseMetaFromMemoryState } from './handleIrosReply.state';
import { loadLatestIrDiagnosisSnapshot, loadIrDiagnosisInventorySnapshot, loadIrDiagnosisDetailSnapshot } from '@/lib/iros/memoryRecall';
import { routeIrosMemory } from '@/lib/iros/memory/memoryRouter';
import { resolveWorkingReference } from '@/lib/iros/memory/workingReferenceResolver';
import { guardIrosMemoryDecision } from '@/lib/iros/memory/memoryGuard';
import { buildMemorySeed } from '@/lib/iros/memory/memorySeedBuilder';
import { runPreSeedAssist } from '@/lib/iros/memory/preSeedAssist';
import { resolvePendingOfferFromUserText } from '@/lib/iros/memory/continuityOffer.extractor';
import { buildDiagnosisActiveContextFrame } from '@/lib/iros/anchor/activeContextAnchor';

// ✅ FramePlan（器＋スロット）(Layer C/D)
import { buildFramePlan, type InputKind, type IrosStateLite } from '@/lib/iros/language/frameSlots';
import { resolveFocusResolution } from '@/lib/iros/conversation/focusResolution';
import { resolveMuSelfKnowledge } from '@/lib/iros/knowledge/muSelfKnowledge';
import { resolveTurnFrame } from '@/lib/iros/turnFrame/resolveTurnFrame';

// ✅ 外部conversationId(string) -> DB conversation_id(uuid) 変換
import { ensureIrosConversationUuid } from './ensureIrosConversationUuid';

function normOptString(v: unknown): string | undefined {
  const s = String(v ?? '').trim();
  return s.length > 0 ? s : undefined;
}

function extractDiagnosisFollowupTargetLabel(text: string): string | null {
  const s = String(text ?? '')
    .replace(/[\s　]+/g, ' ')
    .trim();

  if (!s) return null;

  const patterns = [
    /^(.+?)の(?:今の)?(?:状況|状態|診断内容|診断結果|診断|こと|件)?を?診断(?:を元に|をもとに|に基づいて|にもとづいて|を踏まえて|ベースで|から)/u,
    /^(.+?)の(?:今の)?(?:状況|状態|診断内容|診断結果|診断|こと|件).*(?:詳しく|詳細|深く|深めて|深める|掘り下げ|具体的に|説明して|解説して)/u,
    /^(.+?)について.*診断(?:を元に|をもとに|に基づいて|にもとづいて|を踏まえて|ベースで|から)/u,
    /^(.+?)について.*(?:詳しく|詳細|深く|深めて|深める|掘り下げ|具体的に|説明して|解説して)/u,
  ];

  for (const pattern of patterns) {
    const m = s.match(pattern);
    const raw = String(m?.[1] ?? '').trim();
    if (!raw) continue;

    const cleaned = raw
      .replace(/^(この|その|さっきの|前の|今の)\s*/u, '')
      .replace(/[、。,.!?！？：:「」『』【】\[\]()（）]+$/g, '')
      .trim();

    if (!cleaned) continue;
    if (/^(診断|診断内容|診断結果|状況|状態|今|これ|それ|自分)$/.test(cleaned)) continue;
    if (cleaned.length > 24) continue;

    return cleaned;
  }

  return null;
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

  const compact = s
    .replace(/\s+/g, '')
    .replace(/[。．.!！?？…]+$/g, '')
    .toLowerCase();

  // ✅ short ACK / 接続反応
  // 「確かに！」などは新規相談ではなく、直前応答への受領・同意として扱う。
  // ここで micro にしておくことで、chat として新規テーマ化されるのを防ぐ。
  if (
    /^(うん|うんうん|はい|そう|そうです|そうですね|なるほど|たしかに|確かに|それです|それだ|わかった|分かった|了解|ok|おけ|ありがとう|助かる)$/.test(
      compact,
    )
  ) {
    return 'micro';
  }

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

  // ✅ compose / writing task
  // 「使える文ください」「返信文ください」などは、共鳴会話ではなく文面作成タスクとして扱う。
  if (/(文章|文面|例文|使える文|返信文|LINE文|ライン文|送る文|送信文|返す文|返事文|相手に送る|なんて送れば|どう送れば|どう返せば|文ください|文をください|文を作って|まとめて)/.test(s)) {
    return 'task';
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
  const detailSourceText =
    normOptString((baseMetaForTurn as any)?.userText) ??
    normOptString((baseMetaForTurn as any)?.inputText) ??
    normOptString((baseMetaForTurn as any)?.text) ??
    normOptString(text) ??
    '';

  const wantsDetail =
    /詳しく|詳細|もう少し|深く|深めて|深める|掘り下げ|掘って|診断を元に|診断をもとに|診断に基づいて|診断にもとづいて|診断を踏まえて|診断ベース|診断内容|診断結果|診断の結果|以前の診断|前回の診断|さっきの診断|前の診断|この診断|今の診断/.test(
      detailSourceText
    );

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

  const workingReferenceForMemoryRouter = resolveWorkingReference({
    currentQuestion: followupSourceText,
    historyForTurn: (args as any)?.history,
    orchCtxPack: (baseMetaForTurn as any)?.extra?.ctxPack,
    orchExtra: (baseMetaForTurn as any)?.extra,
    extraLocal: (baseMetaForTurn as any)?.extra,
  });

  const memoryDecision = routeIrosMemory({
    userText: followupSourceText,
    workingReference: workingReferenceForMemoryRouter,
  });
  const memoryGuardDecision = guardIrosMemoryDecision(memoryDecision);
  const diagnosisFollowupTargetLabel =
    (memoryDecision.memoryIntent === 'diagnosis_recall'
      ? memoryDecision.targetLabel
      : null) ||
    extractDiagnosisFollowupTargetLabel(followupSourceText);


  if (memoryDecision.memoryIntent === 'reference_check') {
    (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
    (baseMetaForTurn as any).extra.ctxPack =
      (baseMetaForTurn as any).extra.ctxPack ?? {};

    (baseMetaForTurn as any).extra.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.memoryRecallMode = memoryDecision.recallMode;

    (baseMetaForTurn as any).extra.ctxPack.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.ctxPack.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.ctxPack.memoryRecallMode = memoryDecision.recallMode;
  }

  if (memoryDecision.memoryIntent === 'relationship_recall') {
    (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
    (baseMetaForTurn as any).extra.ctxPack =
      (baseMetaForTurn as any).extra.ctxPack ?? {};

    (baseMetaForTurn as any).extra.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.memoryRecallMode = memoryDecision.recallMode;

    (baseMetaForTurn as any).extra.ctxPack.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.ctxPack.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.ctxPack.memoryRecallMode = memoryDecision.recallMode;
  }
  const isFollowupRequest =
    /詳しく|詳しく教えて|詳しく説明|部分|この部分|その部分|という部分|と言う部分|箇所|この箇所|その箇所|とはどんな状態|とはどういう状態|とは何|ってどんな状態|ってどういう状態|どんな状態ですか|どういう状態ですか|具体的に|具体化|わかりやすく|分かりやすく|つまり|どういうこと|それって|どうすれば|何をすれば|何から|どこから|どう扱えば|どう受け取れば|どう見れば|続き|続きを|診断の続き|言い換えて|言い換え|翻訳して|翻訳|簡単に|一言で|説明して|解説して|補足して|もう少し|もう少し深く|深く|深めて|深める|掘り下げ|掘って|その理由|理由|なぜそうなる|なぜ|どうしてそうなる|どうして|なんでそうなる|なんで|診断を元に|診断をもとに|診断に基づいて|診断にもとづいて|診断を踏まえて|診断ベース|診断から|どんな内容|その内容|内容でした|内容を教えて|中身|診断内容|診断結果|診断の結果|以前の診断|前回の診断|さっきの診断|前の診断|この診断|今の診断/.test(
      followupSourceText
    );

  // ✅ 創作・書き直し系の継続要求は、診断 followup に入れない。
  // 例: 「はい、書いてください」「もう少しリアルに書いてください」「それを書いて」「続きを書いて」
  // これらは直前イベントの継続であり、IR_DETAIL_V1 の診断深掘りではない。
  const isCreativeContinuationRequest =
    /(はい、?書いて|書いてください|書いて下さい|それを書いて|あれを書いて|これを書いて|続きを書いて|続き書いて|書き起こして|書き直して|リアルに書いて|もっとリアル|もう少しリアル|自然文寄り|会話っぽく)/.test(
      followupSourceText
    );


  const wantsDiagnosisInventory =
    !isIrDiagnosisTurn &&
    !isCreativeContinuationRequest &&
    /(?:診断|ir診断|IR診断|診断内容|診断結果).*(?:どれくらい|何件|何個|いくつ|一覧|リスト|持ってる|持っています|残ってる|保存|記録)|(?:どれくらい|何件|何個|いくつ|一覧|リスト).*(?:診断|ir診断|IR診断|診断内容|診断結果)/u.test(
      followupSourceText
    );

  const diagnosisInventoryTargetLabel = (() => {
    const text = String(followupSourceText ?? '').trim();

    if (/(自分|自分自身|僕|私|俺|わたし|ぼく)の(?:過去の)?(?:ir診断|IR診断|診断|診断内容|診断結果)/u.test(text)) {
      return '自分';
    }

    const m =
      text.match(/^\s*(.+?)(?:の|について|に関する)(?:過去の)?(?:ir診断|IR診断|診断|診断内容|診断結果)/u) ??
      text.match(/(?:ir診断|IR診断|診断|診断内容|診断結果).*(?:対象|相手|人)[：:\s]*([^\s　、。？?]+)/u);

    const raw = String(m?.[1] ?? '').trim();
    if (!raw) return null;

    const cleaned = raw
      .replace(/[「」『』]/g, '')
      .replace(/(さん|ちゃん|くん|様|先生)$/u, '')
      .trim();

    if (!cleaned || /^(過去|保存済み|直近|前回|今回|全部|全体|一覧|リスト|診断|ir診断|IR診断)$/u.test(cleaned)) {
      return null;
    }

    return cleaned;
  })();

  if (wantsDiagnosisInventory) {
    try {
      const diagnosisInventory = await loadIrDiagnosisInventorySnapshot(supabase, userCode, 10, diagnosisInventoryTargetLabel);

      const recentLines = diagnosisInventory.recent.map((item) => {
        const id = typeof item.id === 'number' ? String(item.id) : '不明';
        const target = item.targetLabel ? item.targetLabel : '対象未設定';
        const created = item.createdAt ? item.createdAt.slice(0, 10) : '日付不明';
        const head = item.diagnosisTextHead ? item.diagnosisTextHead.replace(/\s+/g, ' ').slice(0, 72) : '本文なし';
        return 'ID:' + id + ' / ' + target + ' / ' + created + ' / ' + head;
      });

      const diagnosisInventoryTargetPrefix = diagnosisInventoryTargetLabel
        ? diagnosisInventoryTargetLabel + 'の'
        : '';

      const suggestedTargetLabels = Array.isArray((diagnosisInventory as any).suggestedTargetLabels)
        ? (diagnosisInventory as any).suggestedTargetLabels
            .map((x: unknown) => String(x ?? '').trim())
            .filter((x: string) => x.length > 0)
        : [];

      const suggestionLines =
        diagnosisInventory.totalCount === 0 &&
        diagnosisInventoryTargetLabel &&
        suggestedTargetLabels.length > 0
          ? [
              '',
              '近い対象名があります。',
              ...suggestedTargetLabels.map((name: string) => '・' + name),
              '',
              '対象名をこの表記で聞くと絞り込めます。',
            ]
          : [];

      const directReply = diagnosisInventory.error
        ? ['今は保存済み診断リストを確認できません。', '', `理由: ${diagnosisInventory.error}`].join('\n')
        : diagnosisInventory.totalCount > 0
          ? [
              `${diagnosisInventoryTargetPrefix}保存済みのir診断は ${diagnosisInventory.totalCount}件あります。`,
              `直近で見えているのは ${diagnosisInventory.recent.length}件です。`,
              diagnosisInventory.hasMore ? 'それ以前の診断もDB上には残っています。' : '今見えている範囲で全件です。',
              '',
              ...recentLines,
            ].join('\n')
          : [
              `${diagnosisInventoryTargetPrefix}保存済みのir診断は、今のDB上では0件です。`,
              ...suggestionLines,
            ].join('\n');
      const inventoryPreSeedResult = {
        version: 'pre_seed_assist_v1',
        kind: 'diagnosis_inventory',
        confidence: 1,
        targetLabel: diagnosisInventoryTargetLabel,
        targetKey: null,
        directReply,
        seedText: [
          'PRE_SEED_DIAGNOSIS_INVENTORY:',
          'userText=' + followupSourceText,
          'targetLabel=' + String(diagnosisInventoryTargetLabel ?? ''),
          'totalCount=' + diagnosisInventory.totalCount,
          'recentCount=' + diagnosisInventory.recent.length,
          'hasMore=' + String(diagnosisInventory.hasMore),
          'rule=保存済みir診断の件数と直近リストをDB結果として直返しする。',
        ].join('\n'),
        shouldBypassWriter: true,
        reason: 'diagnosis_inventory_direct_reply',
      };

      (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
      (baseMetaForTurn as any).extra.ctxPack =
        (baseMetaForTurn as any).extra.ctxPack ?? {};

      (baseMetaForTurn as any).extra.preSeedAssistResult = inventoryPreSeedResult;
      (baseMetaForTurn as any).extra.preSeedAssistKind = inventoryPreSeedResult.kind;
      (baseMetaForTurn as any).extra.preSeedAssistConfidence = inventoryPreSeedResult.confidence;
      (baseMetaForTurn as any).extra.preSeedAssistSeedText = inventoryPreSeedResult.seedText;
      (baseMetaForTurn as any).extra.preSeedAssistDirectReply = directReply;
      (baseMetaForTurn as any).extra.preSeedAssistShouldBypassWriter = true;
      (baseMetaForTurn as any).extra.directReplyCandidate = directReply;
      (baseMetaForTurn as any).extra.diagnosisInventory = diagnosisInventory;

      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistResult = inventoryPreSeedResult;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistKind = inventoryPreSeedResult.kind;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistConfidence = inventoryPreSeedResult.confidence;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistSeedText = inventoryPreSeedResult.seedText;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistDirectReply = directReply;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistShouldBypassWriter = true;
      (baseMetaForTurn as any).extra.ctxPack.directReplyCandidate = directReply;
      (baseMetaForTurn as any).extra.ctxPack.diagnosisInventory = diagnosisInventory;

      console.log('[IROS/DIAGNOSIS_INVENTORY_DIRECT]', {
        userCode,
        targetLabel: diagnosisInventoryTargetLabel,
        totalCount: diagnosisInventory.totalCount,
        recentCount: diagnosisInventory.recent.length,
        hasMore: diagnosisInventory.hasMore,
        error: diagnosisInventory.error ?? null,
      });
    } catch (e) {
      console.warn('[IROS/DIAGNOSIS_INVENTORY_DIRECT][FAILED]', {
        userCode,
        error: String((e as any)?.message ?? e),
      });
    }
  }

  const diagnosisDetailIdMatch = followupSourceText.match(
    /(?:^|\s)(?:ID|id)[:：]?\s*(\d+)\s*(?:の)?(?:内容|詳しく|詳細|教えて|見せて|確認)/u
  );

  const diagnosisDetailLegacyMatch = followupSourceText.match(
    /^\s*([^\/\n]+?)\s*\/\s*([SFRCTI]\d)\s*\/\s*(\d{4}-\d{2}-\d{2})\s*\/?.*(?:内容|詳しく|詳細|教えて|見せて|確認)/u
  );

  const diagnosisDetailMatch = diagnosisDetailIdMatch || diagnosisDetailLegacyMatch;

  if (!isIrDiagnosisTurn && !isCreativeContinuationRequest && diagnosisDetailMatch) {
    try {
      const diagnosisDetailId = diagnosisDetailIdMatch ? Number(diagnosisDetailIdMatch[1] ?? 0) : null;
      const diagnosisDetailTargetLabel = diagnosisDetailLegacyMatch ? String(diagnosisDetailLegacyMatch[1] ?? '').trim() : '';
      const diagnosisDetailDepthStage = diagnosisDetailLegacyMatch ? String(diagnosisDetailLegacyMatch[2] ?? '').trim() : '';
      const diagnosisDetailCreatedDate = diagnosisDetailLegacyMatch ? String(diagnosisDetailLegacyMatch[3] ?? '').trim() : '';

      const diagnosisDetailLookup =
        Number.isFinite(diagnosisDetailId) && Number(diagnosisDetailId) > 0
          ? { id: Math.trunc(Number(diagnosisDetailId)) }
          : {
              targetLabel: diagnosisDetailTargetLabel,
              depthStage: diagnosisDetailDepthStage,
              createdDate: diagnosisDetailCreatedDate,
            };

      const diagnosisDetail = await loadIrDiagnosisDetailSnapshot(supabase, userCode, diagnosisDetailLookup);
      const directReply = diagnosisDetail.error
        ? [
            '今は指定された診断本文を確認できません。',
            '',
            '理由: ' + diagnosisDetail.error,
          ].join('\n')
        : diagnosisDetail.found && diagnosisDetail.diagnosisText
          ? [
              '診断の本文はこちらです。',
              '',
              'ID:' + String(diagnosisDetail.id ?? diagnosisDetailId ?? ''),
              '対象: ' + (diagnosisDetail.targetLabel ?? diagnosisDetailTargetLabel),
              '日付: ' + (diagnosisDetail.createdAt ? diagnosisDetail.createdAt.slice(0, 10) : diagnosisDetailCreatedDate),
              '',
              String(diagnosisDetail.diagnosisText ?? '').trim(),
            ].join('\n')
          : [
              '指定された診断本文は、今のDB上では見つかりませんでした。',
              '',
              '指定: ' + (Number.isFinite(diagnosisDetailId) && Number(diagnosisDetailId) > 0 ? 'ID:' + String(Math.trunc(Number(diagnosisDetailId))) : diagnosisDetailTargetLabel + ' / ' + diagnosisDetailCreatedDate),
            ].join('\n');

      const detailPreSeedResult = {
        version: 'pre_seed_assist_v1',
        kind: 'diagnosis_detail',
        confidence: 1,
        targetLabel: diagnosisDetailTargetLabel,
        targetKey: null,
        directReply,
        seedText: [
          'PRE_SEED_DIAGNOSIS_DETAIL:',
          'userText=' + followupSourceText,
          'id=' + (Number.isFinite(diagnosisDetailId) && Number(diagnosisDetailId) > 0 ? String(Math.trunc(Number(diagnosisDetailId))) : ''),
          'targetLabel=' + diagnosisDetailTargetLabel,
          'depthStage=' + diagnosisDetailDepthStage,
          'createdDate=' + diagnosisDetailCreatedDate,
          'found=' + String(diagnosisDetail.found),
          'rule=保存済みir診断の指定1件をDB結果として直返しする。',
        ].join('\n'),
        shouldBypassWriter: true,
        reason: 'diagnosis_detail_direct_reply',
      };

      (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
      (baseMetaForTurn as any).extra.ctxPack =
        (baseMetaForTurn as any).extra.ctxPack ?? {};

      (baseMetaForTurn as any).extra.preSeedAssistResult = detailPreSeedResult;
      (baseMetaForTurn as any).extra.preSeedAssistKind = detailPreSeedResult.kind;
      (baseMetaForTurn as any).extra.preSeedAssistConfidence = detailPreSeedResult.confidence;
      (baseMetaForTurn as any).extra.preSeedAssistSeedText = detailPreSeedResult.seedText;
      (baseMetaForTurn as any).extra.preSeedAssistDirectReply = directReply;
      (baseMetaForTurn as any).extra.preSeedAssistShouldBypassWriter = true;
      (baseMetaForTurn as any).extra.directReplyCandidate = directReply;
      (baseMetaForTurn as any).extra.diagnosisDetail = diagnosisDetail;

      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistResult = detailPreSeedResult;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistKind = detailPreSeedResult.kind;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistConfidence = detailPreSeedResult.confidence;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistSeedText = detailPreSeedResult.seedText;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistDirectReply = directReply;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistShouldBypassWriter = true;
      (baseMetaForTurn as any).extra.ctxPack.directReplyCandidate = directReply;
      (baseMetaForTurn as any).extra.ctxPack.diagnosisDetail = diagnosisDetail;

      console.log('[IROS/DIAGNOSIS_DETAIL_DIRECT]', {
        userCode,
        targetLabel: diagnosisDetailTargetLabel,
        id: Number.isFinite(diagnosisDetailId) && Number(diagnosisDetailId) > 0 ? Math.trunc(Number(diagnosisDetailId)) : null,
        createdDate: diagnosisDetailCreatedDate,
        found: diagnosisDetail.found,
        error: diagnosisDetail.error ?? null,
      });
    } catch (e) {
      console.warn('[IROS/DIAGNOSIS_DETAIL_DIRECT][FAILED]', {
        userCode,
        error: String((e as any)?.message ?? e),
      });
    }
  }
  // 🔶 先に DB 側の最新診断 snapshot を読む
  // いままでは isDiagnosisFollowup が true の時しか読まなかったため、
  // prevIrMeta が null のケースで永久に発火しない循環になっていた
  let lastIrDiagnosis: any = null;

  if (!isIrDiagnosisTurn && isFollowupRequest && !isCreativeContinuationRequest) {
    try {
      lastIrDiagnosis = await loadLatestIrDiagnosisSnapshot(supabase, userCode, diagnosisFollowupTargetLabel);
    } catch (e) {
      console.warn('[IROS][diagnosisFollowup] load failed', e);
    }
  }

  const hasDiagnosisSource = !!prevIrMeta || !!lastIrDiagnosis;

  const isDiagnosisFollowup =
    !isCreativeContinuationRequest &&
    !isIrDiagnosisTurn &&
    hasDiagnosisSource &&
    isFollowupRequest;

  const diagnosisFollowupKind: 'concretize' | 'action' | 'rephrase' | 'deepen' | null =
    !isDiagnosisFollowup
      ? null
      : /どうすれば|何をすれば|次は|どう動く|何から|どこから|どう扱えば|どう進める|進め方|一手|行動|対処/.test(followupSourceText)
        ? 'action'
        : /言い換えて|言い換え|翻訳して|翻訳|簡単に|一言で|わかりやすく|分かりやすく|つまり|どういうこと|説明して|解説して|補足して|どんなでしたっけ|どんなでしたか|何でしたっけ|診断の結果/.test(followupSourceText)
          ? 'rephrase'
          : /詳しく|詳しく教えて|詳しく説明|部分|この部分|その部分|という部分|と言う部分|箇所|この箇所|その箇所|とはどんな状態|とはどういう状態|とは何|ってどんな状態|ってどういう状態|どんな状態ですか|どういう状態ですか|もう少し深く|深く|深めて|深める|掘り下げ|掘って|その理由|理由|なぜそうなる|なぜ|どうしてそうなる|どうして|なんでそうなる|なんで|診断を元に|診断をもとに|診断に基づいて|診断にもとづいて|診断を踏まえて|診断ベース|診断から|診断内容|診断結果|診断の結果|以前の診断|前回の診断|さっきの診断|前の診断|この診断|今の診断/.test(followupSourceText)
            ? 'deepen'
            : 'concretize';

  // 🔥 履歴ベース再診断フラグ
  const isDiagnosisDetailTurn =
    !isCreativeContinuationRequest &&
    !isIrDiagnosisTurn &&
    !isDiagnosisFollowup &&
    wantsDetail &&
    hasDiagnosisSource;

  console.log(
    '[IROS/CONTEXT][DIAG_FOLLOWUP_CHECK_JSON]',
    JSON.stringify({
      isIrDiagnosisTurn,
      wantsDetail,
      isFollowupRequest,
      hasDiagnosisSource,
      isDiagnosisFollowup,
      isDiagnosisDetailTurn,
      diagnosisFollowupKind,
      diagnosisFollowupTargetLabel,
      followupSourceText,
      prevIrMetaTargetLabel:
        String((prevIrMeta as any)?.targetLabel ?? '').trim() || null,
      hasPrevIrMeta: !!prevIrMeta,
      lastIrDiagnosisTarget:
        String((lastIrDiagnosis as any)?.target ?? '').trim() || null,
      hasLastIrDiagnosis: !!lastIrDiagnosis,
    })
  );

  if (isDiagnosisFollowup || isDiagnosisDetailTurn) {
    (baseMetaForTurn as any).extra = (baseMetaForTurn as any).extra ?? {};
    (baseMetaForTurn as any).extra.ctxPack =
      (baseMetaForTurn as any).extra.ctxPack ?? {};
    (baseMetaForTurn as any).extra.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.memoryRecallMode = memoryDecision.recallMode;

    (baseMetaForTurn as any).extra.ctxPack.memoryDecision = memoryDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardDecision = memoryGuardDecision;
    (baseMetaForTurn as any).extra.ctxPack.memoryGuardReasons = memoryGuardDecision.guardReasons;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowWriterSeed = memoryGuardDecision.allowWriterSeed;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowLongTermSave = memoryGuardDecision.allowLongTermSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowPastStateMerge = memoryGuardDecision.allowPastStateMerge;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowDiagnosisSave = memoryGuardDecision.allowDiagnosisSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryAllowRelationshipSave = memoryGuardDecision.allowRelationshipSave;
    (baseMetaForTurn as any).extra.ctxPack.memoryIntent = memoryDecision.memoryIntent;
    (baseMetaForTurn as any).extra.ctxPack.memorySpace = memoryDecision.memorySpace;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetLabel = memoryDecision.targetLabel;
    (baseMetaForTurn as any).extra.ctxPack.memoryTargetKey = memoryDecision.targetKey;
    (baseMetaForTurn as any).extra.ctxPack.memoryRecallMode = memoryDecision.recallMode;

    // Diagnosis follow-up must not inherit unrelated pastStateNoteText.
    // lastIrDiagnosis / irMeta are the source of truth for this branch.
    (baseMetaForTurn as any).extra.pastStateNoteText = null;
    (baseMetaForTurn as any).extra.pastStateTriggerKind = null;
    (baseMetaForTurn as any).extra.ctxPack.pastStateNoteText = null;
    (baseMetaForTurn as any).extra.ctxPack.pastStateTriggerKind = null;

    if (diagnosisFollowupTargetLabel) {
      (baseMetaForTurn as any).extra.diagnosisFollowupTargetLabel =
        diagnosisFollowupTargetLabel;
      (baseMetaForTurn as any).extra.ctxPack.diagnosisFollowupTargetLabel =
        diagnosisFollowupTargetLabel;
    }

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
      lastIrDiagnosisResolved
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
        : prevIrMeta;

    const resolvedDiagnosisTargetLabel =
      diagnosisFollowupTargetLabel ||
      String((lastIrDiagnosisResolved as any)?.target ?? '').trim() ||
      String((normalizedIrMeta as any)?.targetLabel ?? '').trim() ||
      null;

    const activeContextFrameForDiagnosis = buildDiagnosisActiveContextFrame({
      targetLabel: resolvedDiagnosisTargetLabel,
      targetKey:
        (baseMetaForTurn as any)?.extra?.memoryTargetKey ??
        (baseMetaForTurn as any)?.extra?.ctxPack?.memoryTargetKey ??
        null,
      activeDiagnosisId:
        (baseMetaForTurn as any)?.extra?.activeDiagnosisId ??
        (baseMetaForTurn as any)?.extra?.ctxPack?.activeDiagnosisId ??
        null,
      lastIrDiagnosis: lastIrDiagnosisResolved,
      irMeta: normalizedIrMeta,
      followupRequest: followupSourceText,
      lastAction: isDiagnosisFollowup
        ? 'diagnosis_' + (diagnosisFollowupKind ?? 'followup')
        : 'diagnosis_detail',
    });

    if (activeContextFrameForDiagnosis) {
      (baseMetaForTurn as any).extra.activeContextFrame =
        activeContextFrameForDiagnosis;
      (baseMetaForTurn as any).extra.ctxPack.activeContextFrame =
        activeContextFrameForDiagnosis;
    }

    const presentationKindForDiagnosisContext = isDiagnosisFollowup ? 'diagnosis_followup' : 'diagnosis';
    (baseMetaForTurn as any).targetLabel = resolvedDiagnosisTargetLabel;
    (baseMetaForTurn as any).presentationKind = presentationKindForDiagnosisContext;

    (baseMetaForTurn as any).extra.isIrDiagnosisTurn = false;
    (baseMetaForTurn as any).extra.presentationKind = presentationKindForDiagnosisContext;
    (baseMetaForTurn as any).extra.targetLabel = resolvedDiagnosisTargetLabel;
    (baseMetaForTurn as any).extra.irMeta = normalizedIrMeta;

    (baseMetaForTurn as any).extra.ctxPack.presentationKind = presentationKindForDiagnosisContext;
    (baseMetaForTurn as any).extra.ctxPack.targetLabel = resolvedDiagnosisTargetLabel;
    (baseMetaForTurn as any).extra.ctxPack.irMeta = normalizedIrMeta;
    if (lastIrDiagnosisResolved) {
      (baseMetaForTurn as any).extra.lastIrDiagnosis = lastIrDiagnosisResolved;
      (baseMetaForTurn as any).extra.ctxPack.lastIrDiagnosis = lastIrDiagnosisResolved;
    }

    if (isDiagnosisDetailTurn) {
      const resolvedDetailKind =
        diagnosisFollowupKind ?? 'concretize';

      (baseMetaForTurn as any).extra.detailMode = true;
      (baseMetaForTurn as any).extra.followupKind = resolvedDetailKind;
      (baseMetaForTurn as any).extra.diagnosisFollowup = true;

      (baseMetaForTurn as any).extra.ctxPack.detailMode =
        prevDetailMode || true;
      (baseMetaForTurn as any).extra.ctxPack.followupKind = resolvedDetailKind;
      (baseMetaForTurn as any).extra.ctxPack.diagnosisFollowup = true;
      (baseMetaForTurn as any).extra.ctxPack.continuityKind =
        'diagnosis_followup';
      (baseMetaForTurn as any).extra.ctxPack.goalKind =
        resolvedDetailKind === 'action' ? 'action' : 'clarify';
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
      // IROS_DIAG_FOLLOWUP_STALE_SEED_CLEANUP
      // 診断フォロー用の内部seedは、そのターン専用。次ターンへ持ち越さない。
      {
        const extraAny: any = (baseMetaForTurn as any).extra ?? {};
        const ctxPackAny: any = extraAny.ctxPack ?? {};

        delete extraAny.diagnosisFollowupAnalysisSeed;
        delete ctxPackAny.diagnosisFollowupAnalysisSeed;

        const existingMemoryPreSeedText = String(
          extraAny.memoryPreSeedText ?? ctxPackAny.memoryPreSeedText ?? ''
        ).trim();

        if (
          existingMemoryPreSeedText.startsWith('DIAGNOSIS_FOLLOWUP_ANALYSIS_SEED:') ||
          existingMemoryPreSeedText.startsWith('PRE_SEED_DIAGNOSIS_FOLLOWUP_PHRASE_DETAIL_DIRECT:')
        ) {
          delete extraAny.memoryPreSeedText;
          delete ctxPackAny.memoryPreSeedText;
        }
      }

      let preSeedAssistResult = await runPreSeedAssist({
        userText: followupSourceText,
        ctxPack: (baseMetaForTurn as any).extra.ctxPack,
        activeContextFrame: activeContextFrameForDiagnosis,
        lastIrDiagnosis: lastIrDiagnosisResolved,
        historyForWriter: Array.isArray((args as any).history)
          ? ((args as any).history as any[])
          : [],
        traceId: args.traceId ?? null,
        conversationId,
        userCode,
      });

      const compactFollowupSourceTextForMuCapabilityMeta =
        followupSourceText.replace(/[\s　、。！？!?「」『』（）()]/g, '');

      const isMuCapabilityMetaQuestionForPreSeedAssist =
        /^(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(どうして|なんで|なぜ|何で).*(わかる|分かる|読める|見える|回答|答え|返答|できる|出来る)/u.test(
          compactFollowupSourceTextForMuCapabilityMeta
        ) ||
        /^(どうして|なんで|なぜ|何で).*(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(わかる|分かる|読める|見える|回答|答え|返答|できる|出来る)/u.test(
          compactFollowupSourceTextForMuCapabilityMeta
        ) ||
        /(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(仕組み|原理|なぜ|どうして|なんで|何で).*(回答|答え|返答|わかる|分かる|できる|出来る)/u.test(
          compactFollowupSourceTextForMuCapabilityMeta
        );

      if (isMuCapabilityMetaQuestionForPreSeedAssist) {
        preSeedAssistResult = {
          ...preSeedAssistResult,
          kind: 'normal',
          directReply: null,
          shouldBypassWriter: false,
          seedText: '',
          reason:
            String(preSeedAssistResult.reason ?? '') +
            '; mu_capability_meta_question_skip_diagnosis_followup',
        };
      }

      const diagnosisFollowupPhraseDetailRequested =
        /詳しく|詳しく教えて|詳しく説明|部分|この部分|その部分|という部分|と言う部分|箇所|この箇所|その箇所|とはどんな状態|とはどういう状態|とは何|ってどんな状態|ってどういう状態|どんな状態ですか|どういう状態ですか/u.test(followupSourceText);

      if (
        !isMuCapabilityMetaQuestionForPreSeedAssist &&
        diagnosisFollowupPhraseDetailRequested &&
        lastIrDiagnosisResolved
      ) {
        const diagnosisFollowupSourceText = String(
          (lastIrDiagnosisResolved as any)?.summary ??
            (lastIrDiagnosisResolved as any)?.diagnosisText ??
            (lastIrDiagnosisResolved as any)?.diagnosis_text ??
            (lastIrDiagnosisResolved as any)?.text ??
            (lastIrDiagnosisResolved as any)?.assistantText ??
            (lastIrDiagnosisResolved as any)?.observation ??
            (lastIrDiagnosisResolved as any)?.state ??
            ''
        ).trim();

        const phraseMatch = followupSourceText.match(
          /(.+?)(?:と(?:い|言)う部分|という部分|の部分|という箇所|の箇所|とはどんな状態|とはどういう状態|とは何|ってどんな状態|ってどういう状態|はどんな状態|はどういう状態|を詳しく|について詳しく|を説明|を教えて)/u
        );

        const diagnosisFollowupSourcePhrase = String(phraseMatch?.[1] ?? '')
          .replace(/^(この|その|前の|さっきの)/u, '')
          .trim() || followupSourceText;

        if (diagnosisFollowupSourceText) {
          const normalizedDiagnosisText = diagnosisFollowupSourceText
            .replace(/\s+/g, ' ')
            .trim();

          const diagnosisSentences = normalizedDiagnosisText
            .split(/[。！？]/u)
            .map((x) => x.trim())
            .filter(Boolean);

          const phraseSentence =
            diagnosisSentences.find((x) => x.includes(diagnosisFollowupSourcePhrase)) ??
            diagnosisSentences[0] ??
            '';

          const supportSentence =
            diagnosisSentences.find((x) =>
              x !== phraseSentence &&
              /現状|ポイント|意識の向かう先|メッセージ|曖昧|踏み込む|距離を引く|反応を見ながら|形にする|関わり|興味|温度|具体的/u.test(x)
            ) ??
            diagnosisSentences.find((x) => x !== phraseSentence) ??
            '';

          const phraseLine = phraseSentence
            ? `診断本文では、「${phraseSentence}。」という文脈で出ています。`
            : '前回診断本文の中で出ていた表現です。';

          const supportLine =
            supportSentence && supportSentence !== phraseSentence
              ? `補足すると、「${supportSentence}。」という内容ともつながっています。`
              : '';

          const diagnosisTargetLabelForReply = String(resolvedDiagnosisTargetLabel ?? '').trim();
          const diagnosisSubjectLabel =
            !diagnosisTargetLabelForReply || /^(自分|自分自身|私|僕|俺)$/u.test(diagnosisTargetLabelForReply)
              ? 'あなた自身'
              : /関係|二人|ふたり|相性/u.test(diagnosisTargetLabelForReply)
                ? '二人の関係全体'
                : `${diagnosisTargetLabelForReply}側`;

          const isForkPhrase = /分かれ道|踏み込む|距離を引く/u.test(diagnosisFollowupSourcePhrase);

          const meaningLine = isForkPhrase
            ? `つまり、${diagnosisSubjectLabel}が、曖昧なまま関わりを続けることに引っかかりを感じやすくなっていて、続けるなら少し具体的に踏み込む、離れるなら距離を引いて空気を変える、そのどちらかに寄りやすい状態です。`
            : `つまり、${diagnosisSubjectLabel}で、反応や具体的な動きがまだ外へ出にくい状態を指しています。`;

          const closingLine = isForkPhrase
            ? '完全に終わったというより、このまま曖昧に続けるのか、もう少し具体的に動かすのかで、温度が分かれやすい状態です。'
            : '完全に終わったというより、表に出る形がまだ揃いにくい、という意味です。';

          const diagnosisFollowupPhraseDetailDirectReply = [
            `ここで言う「${diagnosisFollowupSourcePhrase}」は、${diagnosisSubjectLabel}の状態として見る表現です。`,
            '',
            phraseLine,
            '',
            supportLine,
            supportLine ? '' : null,
            meaningLine,
            '',
            closingLine,
          ]
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
            .join('\n');
          const diagnosisPhraseDetailContext = {
            kind: 'diagnosis_phrase_detail',
            targetLabel: String(resolvedDiagnosisTargetLabel ?? ''),
            sourcePhrase: diagnosisFollowupSourcePhrase,
            diagnosisId:
              typeof (lastIrDiagnosisResolved as any)?.id === 'number'
                ? (lastIrDiagnosisResolved as any).id
                : null,
            sourceTextHead: diagnosisFollowupSourceText.slice(0, 240),
            createdAt: new Date().toISOString(),
          };

          (baseMetaForTurn as any).extra.lastClarificationContext =
            diagnosisPhraseDetailContext;
          (baseMetaForTurn as any).extra.ctxPack.lastClarificationContext =
            diagnosisPhraseDetailContext;


          preSeedAssistResult = {
            ...preSeedAssistResult,
            kind: 'diagnosis_followup',
            directReply: diagnosisFollowupPhraseDetailDirectReply,
            shouldBypassWriter: true,
            seedText: [
              'PRE_SEED_DIAGNOSIS_FOLLOWUP_PHRASE_DETAIL_DIRECT:',
              'targetLabel=' + String(resolvedDiagnosisTargetLabel ?? ''),
              'sourcePhrase=' + diagnosisFollowupSourcePhrase,
              'rule=診断フォローの指定部分説明なので、Writerへ流さず directReply で返す。',
            ].join('\n'),
            reason:
              String(preSeedAssistResult.reason ?? '') +
              '; diagnosis_followup_phrase_detail_direct_reply',
          };
        }
      }

      const diagnosisFollowupReasonDetailRequested =
        /なぜ|どうして|なんで|理由|原因|なぜそうなる|どういう理由/u.test(followupSourceText);

      if (
        !isMuCapabilityMetaQuestionForPreSeedAssist &&
        diagnosisFollowupReasonDetailRequested &&
        !preSeedAssistResult.shouldBypassWriter &&
        lastIrDiagnosisResolved
      ) {
        const diagnosisFollowupSourceText = String(
          (lastIrDiagnosisResolved as any)?.summary ??
            (lastIrDiagnosisResolved as any)?.diagnosisText ??
            (lastIrDiagnosisResolved as any)?.diagnosis_text ??
            (lastIrDiagnosisResolved as any)?.text ??
            (lastIrDiagnosisResolved as any)?.assistantText ??
            (lastIrDiagnosisResolved as any)?.observation ??
            (lastIrDiagnosisResolved as any)?.state ??
            ''
        ).trim();

        if (diagnosisFollowupSourceText) {
          const normalizedDiagnosisText = diagnosisFollowupSourceText
            .replace(/\s+/g, ' ')
            .trim();

          const diagnosisSentences = normalizedDiagnosisText
            .split(/[。！？]/u)
            .map((x) => x.trim())
            .filter(Boolean);

          const previousClarificationContext: any =
            (baseMetaForTurn as any).extra?.ctxPack?.lastClarificationContext ??
            (baseMetaForTurn as any).extra?.lastClarificationContext ??
            null;

          const reasonTargetRaw = String(followupSourceText)
            .replace(/^[\s「『]*(なぜ|どうして|なんで)[、,\s]*/u, '')
            .replace(/(のですか|なのですか|ですか|でしょうか|なの|です|[？?。])$/u, '')
            .trim();

          const previousSourcePhrase = String(
            previousClarificationContext?.relatedPhrase ??
              previousClarificationContext?.sourcePhrase ??
              ''
          ).trim();

          const reasonTargetPhrase =
            reasonTargetRaw && !/^(その理由|理由|原因|なぜ|どうして|なんで)$/u.test(reasonTargetRaw)
              ? reasonTargetRaw
              : previousSourcePhrase || followupSourceText;

          const reasonKeywordMatches = Array.from(
            reasonTargetPhrase.matchAll(
              /関係を広げる|手が止まり|手が止まる|連絡|約束|温度|具体的な段取り|形にする|一緒に|楽しめる|動きにくい|閉じたまま|広げる|確かめたい/gu
            )
          ).map((m) => m[0]);

          const reasonKeywords = Array.from(
            new Set([reasonTargetPhrase, ...reasonKeywordMatches].filter((x) => String(x).trim().length >= 2))
          );

          const reasonSentence =
            diagnosisSentences.find((x) => reasonKeywords.some((k) => x.includes(k))) ??
            diagnosisSentences.find((x) => /ポイント|現状|意識の向かう先/u.test(x)) ??
            diagnosisSentences[0] ??
            '';

          const supportSentence =
            diagnosisSentences.find(
              (x) =>
                x !== reasonSentence &&
                /意識の向かう先|まず|二人|実際|どこまで|整えて|確かめたい|具体的な段取り|温度|連絡|約束|関係を広げる/u.test(x)
            ) ??
            diagnosisSentences.find((x) => x !== reasonSentence) ??
            '';

          const isRelationReason = /関係|連絡|約束|相手|二人|広げる|温度|みゆ/u.test(
            reasonTargetPhrase + normalizedDiagnosisText
          );

          const openingLine = isRelationReason
            ? `「${reasonTargetPhrase}」理由は、${String(resolvedDiagnosisTargetLabel ?? '相手')}側が関係そのものを大きく進める前に、まず二人の間で実際に何ができるかを確かめたい段階に見えるからです。`
            : `「${reasonTargetPhrase}」理由は、前回診断の中で、その部分が単独の反応ではなく、現状・ポイント・向かう先の流れとしてつながって出ているからです。`;

          const reasonLine = reasonSentence
            ? `診断本文では、「${reasonSentence}。」という内容が根拠になります。`
            : '前回診断本文の流れをもとに見ると、そこは理由を説明できる部分です。';

          const supportLine = supportSentence
            ? `さらに、「${supportSentence}。」という内容ともつながっています。`
            : '';

          const closingLine = isRelationReason
            ? 'つまり、気持ちがないというより、関係の意味を大きく広げる前に、現実の動きとして安心できる形を先に確認したい、という読み方です。'
            : 'つまり、表面の一言だけではなく、その前後にある流れまで含めて見る必要がある、ということです。';

          const actionLine = isRelationReason
            ? 'なので今は、関係の意味を確認するより、一緒にできる具体的な一手を軽く出すほうが合います。'
            : 'なので今は、結論を急ぐより、その状態がどこから出ているのかを分けて見るほうが合います。';

          const diagnosisFollowupReasonDetailDirectReply = [
            openingLine,
            '',
            reasonLine,
            '',
            supportLine,
            supportLine ? '' : null,
            closingLine,
            '',
            actionLine,
          ]
            .filter((x): x is string => typeof x === 'string' && x.length > 0)
            .join('\n');

          const diagnosisReasonDetailContext = {
            kind: 'diagnosis_reason_detail',
            targetLabel: String(resolvedDiagnosisTargetLabel ?? ''),
            sourcePhrase: reasonTargetPhrase,
            relatedPhrase: previousSourcePhrase || null,
            diagnosisId:
              typeof (lastIrDiagnosisResolved as any)?.id === 'number'
                ? (lastIrDiagnosisResolved as any).id
                : null,
            sourceTextHead: diagnosisFollowupSourceText.slice(0, 240),
            createdAt: new Date().toISOString(),
          };

          (baseMetaForTurn as any).extra.diagnosisFollowupOutputMode =
            'reason_detail_direct';
          (baseMetaForTurn as any).extra.ctxPack.diagnosisFollowupOutputMode =
            'reason_detail_direct';
          (baseMetaForTurn as any).extra.lastClarificationContext =
            diagnosisReasonDetailContext;
          (baseMetaForTurn as any).extra.ctxPack.lastClarificationContext =
            diagnosisReasonDetailContext;

          preSeedAssistResult = {
            ...preSeedAssistResult,
            kind: 'diagnosis_followup',
            directReply: diagnosisFollowupReasonDetailDirectReply,
            shouldBypassWriter: true,
            seedText: [
              'PRE_SEED_DIAGNOSIS_FOLLOWUP_REASON_DETAIL_DIRECT:',
              'targetLabel=' + String(resolvedDiagnosisTargetLabel ?? ''),
              'sourcePhrase=' + reasonTargetPhrase,
              'rule=診断フォローの理由説明なので、Writerへ流さず directReply で返す。',
            ].join('\n'),
            reason:
              String(preSeedAssistResult.reason ?? '') +
              '; diagnosis_followup_reason_detail_direct_reply',
          };
        }
      }

      const isDiagnosisResultRecallRequest =
        /(診断の結果|診断結果|以前の診断|前回の診断|さっきの診断|前の診断).*(どんなでしたっけ|どんなでしたか|何でしたっけ|何でしたか|教えて|見せて|確認|再提示|もう一度)|(?:どんなでしたっけ|どんなでしたか|何でしたっけ|何でしたか).*(診断の結果|診断結果|以前の診断|前回の診断|さっきの診断|前の診断)/u.test(
          followupSourceText
        );

      if (
        !isMuCapabilityMetaQuestionForPreSeedAssist &&
        isDiagnosisResultRecallRequest &&
        preSeedAssistResult.kind === 'diagnosis_followup'
      ) {
        const diagnosisResultRecallDirectReply = String(diagnosisTopicHint ?? '').trim()
          ? ['診断の結果はこちらです。', '', String(diagnosisTopicHint ?? '').trim()].join('\n')
          : null;

        preSeedAssistResult = {
          ...preSeedAssistResult,
          directReply: diagnosisResultRecallDirectReply,
          shouldBypassWriter: Boolean(diagnosisResultRecallDirectReply),
          seedText: [
            'PRE_SEED_DIAGNOSIS_RESULT_RECALL:',
            'userText=' + followupSourceText,
            'targetLabel=' + (resolvedDiagnosisTargetLabel ?? ''),
            'rule=診断結果の再提示要求なので、DBから取得済みのlastIrDiagnosisを正本としてそのまま再提示する。',
          ].join('\n'),
          reason: String(preSeedAssistResult.reason ?? '') + '; direct_reply_from_last_ir_diagnosis_for_result_recall',
        };
      }

      (baseMetaForTurn as any).extra.preSeedAssistResult = preSeedAssistResult;
      (baseMetaForTurn as any).extra.preSeedAssistKind = preSeedAssistResult.kind;
      (baseMetaForTurn as any).extra.preSeedAssistConfidence = preSeedAssistResult.confidence;
      (baseMetaForTurn as any).extra.preSeedAssistSeedText = preSeedAssistResult.seedText;
      (baseMetaForTurn as any).extra.preSeedAssistDirectReply = preSeedAssistResult.directReply;
      (baseMetaForTurn as any).extra.preSeedAssistShouldBypassWriter =
        preSeedAssistResult.shouldBypassWriter;

      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistResult = preSeedAssistResult;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistKind = preSeedAssistResult.kind;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistConfidence = preSeedAssistResult.confidence;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistSeedText = preSeedAssistResult.seedText;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistDirectReply =
        preSeedAssistResult.directReply;
      (baseMetaForTurn as any).extra.ctxPack.preSeedAssistShouldBypassWriter =
        preSeedAssistResult.shouldBypassWriter;

      const preSeedAssistSeedTextForMemory = String(preSeedAssistResult.seedText ?? '').trim();
      const shouldPersistPreSeedAssistSeedText =
        Boolean(preSeedAssistSeedTextForMemory) &&
        !(preSeedAssistResult.directReply && preSeedAssistResult.shouldBypassWriter) &&
        !preSeedAssistSeedTextForMemory.startsWith('DIAGNOSIS_FOLLOWUP_ANALYSIS_SEED:') &&
        !preSeedAssistSeedTextForMemory.startsWith('PRE_SEED_DIAGNOSIS_FOLLOWUP_PHRASE_DETAIL_DIRECT:');

      if (shouldPersistPreSeedAssistSeedText) {
        (baseMetaForTurn as any).extra.memoryPreSeedText = preSeedAssistSeedTextForMemory;
        (baseMetaForTurn as any).extra.ctxPack.memoryPreSeedText = preSeedAssistSeedTextForMemory;
      } else if (preSeedAssistSeedTextForMemory) {
        delete (baseMetaForTurn as any).extra.memoryPreSeedText;
        delete (baseMetaForTurn as any).extra.ctxPack.memoryPreSeedText;
      }

      if (preSeedAssistResult.directReply && preSeedAssistResult.shouldBypassWriter) {
        (baseMetaForTurn as any).extra.directReplyCandidate =
          preSeedAssistResult.directReply;
        (baseMetaForTurn as any).extra.ctxPack.directReplyCandidate =
          preSeedAssistResult.directReply;
      }


      const memorySeedResult = buildMemorySeed({
        memoryDecision,
        memoryGuardDecision,
        sourceText: followupSourceText,
        diagnosisText: diagnosisTopicHint,
        activeContextFrame: activeContextFrameForDiagnosis,
      });

      (baseMetaForTurn as any).extra.memorySeedResult = memorySeedResult;
      (baseMetaForTurn as any).extra.memorySeedText = memorySeedResult.seedText;
      (baseMetaForTurn as any).extra.memorySeedKind = memorySeedResult.seedKind;
      (baseMetaForTurn as any).extra.memorySeedBlocked = memorySeedResult.blocked;
      (baseMetaForTurn as any).extra.memorySeedReasons = memorySeedResult.reasons;

      (baseMetaForTurn as any).extra.ctxPack.memorySeedResult = memorySeedResult;
      (baseMetaForTurn as any).extra.ctxPack.memorySeedText = memorySeedResult.seedText;
      (baseMetaForTurn as any).extra.ctxPack.memorySeedKind = memorySeedResult.seedKind;
      (baseMetaForTurn as any).extra.ctxPack.memorySeedBlocked = memorySeedResult.blocked;
      (baseMetaForTurn as any).extra.ctxPack.memorySeedReasons = memorySeedResult.reasons;
    }

      (baseMetaForTurn as any).presentationKind = 'diagnosis';
      if (isIrDiagnosisTurn) {
        (baseMetaForTurn as any).mode = 'diagnosis';
      }
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

  // ✅ Focus & Resolution Director
  // - 本文は生成しない
  // - 今回どこを見るか / どう着地させるかだけを ctxPack に保存する
  // - writer への注入は次段階で行う
  try {
    (baseMetaForTurn as any).extra ??= {};
    (baseMetaForTurn as any).extra.ctxPack ??= {};

    const focusResolution = resolveFocusResolution({
      userText: text,
      conversationLine:
        (baseMetaForTurn as any)?.extra?.ctxPack?.conversationLine ??
        (baseMetaForTurn as any)?.conversationLine ??
        null,
      situationSummary: finalSituationSummary,
      situationTopic: finalSituationTopic,
      goalKind:
        (baseMetaForTurn as any)?.extra?.ctxPack?.goalKind ??
        (baseMetaForTurn as any)?.goalKind ??
        null,
      flowDelta:
        (baseMetaForTurn as any)?.extra?.ctxPack?.flow?.delta ??
        (baseMetaForTurn as any)?.flowDelta ??
        null,
      returnStreak:
        (baseMetaForTurn as any)?.extra?.ctxPack?.flow?.returnStreak ??
        (baseMetaForTurn as any)?.returnStreak ??
        null,
    });

    (baseMetaForTurn as any).extra.focusResolution = focusResolution;
    (baseMetaForTurn as any).extra.ctxPack.focusResolution = focusResolution;

    if (focusResolution.enabled) {
      (baseMetaForTurn as any).extra.ctxPack.focus = focusResolution.focus;
      (baseMetaForTurn as any).extra.ctxPack.resolution = focusResolution.resolution;
      (baseMetaForTurn as any).extra.ctxPack.nextAction = focusResolution.nextAction;
      (baseMetaForTurn as any).extra.ctxPack.outputShape = focusResolution.outputShape;

      // ✅ FocusResolution が有効なターンは、通常共鳴パターンに戻さず、
      //    「焦点→決着→具体行動」へ寄せる実用共鳴パターンへ渡す。
      //    rephraseEngine.full.ts は meta.extra.patternKey を preSelectedPatternKey として読む。
      (baseMetaForTurn as any).extra.patternKey = 'NORMAL_PRACTICAL_RESONANCE_V1';
      (baseMetaForTurn as any).extra.ctxPack.patternKey = 'NORMAL_PRACTICAL_RESONANCE_V1';
      (baseMetaForTurn as any).patternKey = 'NORMAL_PRACTICAL_RESONANCE_V1';

      // ✅ MuSelf Knowledge
      // - 恋愛/人間関係の実用共鳴時に、自己受容・もうひとつの自分へ戻す背景知識を取得する。
      // - ここでは本文生成せず、ctxPack に軽量保存するだけ。
      try {
        const muSelfKnowledge = await resolveMuSelfKnowledge({
          userText: text,
          focusResolution,
          depthStage:
            (baseMetaForTurn as any)?.extra?.ctxPack?.depthStage ??
            (baseMetaForTurn as any)?.depthStage ??
            null,
          qCode:
            (baseMetaForTurn as any)?.extra?.ctxPack?.qCode ??
            (baseMetaForTurn as any)?.qCode ??
            null,
          limit: 3,
        });

        (baseMetaForTurn as any).extra.muSelfKnowledge = muSelfKnowledge;
        (baseMetaForTurn as any).extra.ctxPack.muSelfKnowledge = muSelfKnowledge;

        console.log(
          '[IROS/MU_SELF_KNOWLEDGE]',
          JSON.stringify({
            enabled: muSelfKnowledge.enabled,
            reason: muSelfKnowledge.reason,
            query: muSelfKnowledge.query,
            count: Array.isArray(muSelfKnowledge.items) ? muSelfKnowledge.items.length : 0,
            titles: Array.isArray(muSelfKnowledge.items)
              ? muSelfKnowledge.items.map((x: any) => x?.title).filter(Boolean)
              : [],
          }),
        );
      } catch (e) {
        console.warn('[IROS/MU_SELF_KNOWLEDGE][FAILED]', { error: e });
      }
    }

    console.log(
      '[IROS/FOCUS_RESOLUTION]',
      JSON.stringify({
        enabled: focusResolution.enabled,
        domain: focusResolution.domain,
        reason: focusResolution.reason,
        outputShape: focusResolution.outputShape,
      }),
    );
  } catch (e) {
    console.warn('[IROS/FOCUS_RESOLUTION][FAILED]', { error: e });
  }

  // ✅ eventFrame / seedMode / sourceKind:
  // 接続語・操作語・画像読み・WEB調査などを、メタ・診断・深読みより先に正本化する。
  try {
    const turnFrame = resolveTurnFrame({
      userText: text,
    });

    if (turnFrame.kind !== 'normal' || turnFrame.seedMode !== 'normal') {
      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.eventFrame = turnFrame;
      (baseMetaForTurn as any).extra.turnFrame = turnFrame;
      (baseMetaForTurn as any).extra.seedMode = turnFrame.seedMode;
      (baseMetaForTurn as any).extra.sourceKind = turnFrame.sourceKind;

      (baseMetaForTurn as any).extra.ctxPack.eventFrame = turnFrame;
      (baseMetaForTurn as any).extra.ctxPack.turnFrame = turnFrame;
      (baseMetaForTurn as any).extra.ctxPack.seedMode = turnFrame.seedMode;
      (baseMetaForTurn as any).extra.ctxPack.sourceKind = turnFrame.sourceKind;

      if (turnFrame.kind === 'operate_previous_event') {
        (baseMetaForTurn as any).extra.ctxPack.previousReplyRephrase = true;
        (baseMetaForTurn as any).extra.ctxPack.previousReplyStyleRewrite = true;
        (baseMetaForTurn as any).extra.ctxPack.patternKey = 'previous_reply_rephrase';
        (baseMetaForTurn as any).extra.ctxPack.pattern_key = 'previous_reply_rephrase';
        (baseMetaForTurn as any).extra.ctxPack.patternMode = 'previous_reply_rephrase';
        (baseMetaForTurn as any).extra.ctxPack.pattern_mode = 'previous_reply_rephrase';
        (baseMetaForTurn as any).extra.ctxPack.goalKind = 'rewrite';
        (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'rewrite' };
        (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'operate_previous_event';
        (baseMetaForTurn as any).extra.ctxPack.situationSummary =
          '直前assistant返答の書き直し。現在のユーザー文そのものを分析せず、直前assistant返答を対象にする。';
        (baseMetaForTurn as any).extra.ctxPack.situationTopic =
          '直前assistant返答の書き直し';
      }

      console.log(
        '[IROS/TURN_FRAME][SET]',
        JSON.stringify({
          enabled: true,
          kind: turnFrame.kind,
          seedMode: turnFrame.seedMode,
          sourceKind: turnFrame.sourceKind,
          operation: turnFrame.operation,
          target: turnFrame.target,
          style: turnFrame.style,
          sourceUserText: turnFrame.sourceUserText.slice(0, 120),
        }),
      );
    }
  } catch (e) {
    console.warn('[IROS/TURN_FRAME][FAILED]', { error: e });
  }

  // ✅ スタイル書き直し系では、前ターン由来の creative_continuation を持ち越さない
  // 例:
  // user: はい、書いてください
  // assistant: 物語本文を書く
  // user: もう少しリアルに書いてください
  // => このターンは「直前assistant返答の書き直し」であり、古い creative_continuation resolvedAsk を正本にしない
  try {
    const currentTextForStaleCreativeClear = String(text ?? '').trim();

    const isPreviousReplyStyleRewriteText =
      /(もう少しリアル|もっとリアル|リアルに書いて|現実味|生々しく|もっと自然|自然に|自然文寄り|会話っぽく|少し崩して|柔らかく|やわらかく|短くして|長くして|詳しく書いて|具体的に書いて|もっと具体的に|もう少し具体的に)/u.test(
        currentTextForStaleCreativeClear,
      );

    const extraForStaleCreativeClear = (baseMetaForTurn as any)?.extra ?? {};
    const ctxPackForStaleCreativeClear = extraForStaleCreativeClear?.ctxPack ?? {};

    const staleResolvedAskType =
      String((extraForStaleCreativeClear as any)?.resolvedAsk?.askType ?? '').trim() ||
      String((ctxPackForStaleCreativeClear as any)?.resolvedAsk?.askType ?? '').trim() ||
      String((ctxPackForStaleCreativeClear as any)?.resolvedAskType ?? '').trim();

    const isNewQuotedReferenceSourceText =
      /(?:規約|規定|条件|案内|要項|保証書|募集要項|応募条件|利用条件|配送規定|入場案内|割引条件|予約規約)には[「『][\s\S]{4,}[」』]と書かれています[。.!！?？]?$/u.test(
        currentTextForStaleCreativeClear,
      );

    if (isNewQuotedReferenceSourceText) {
      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      delete (baseMetaForTurn as any).extra.resolvedAsk;
      delete (baseMetaForTurn as any).extra.referenceJudgeSeed;
      delete (baseMetaForTurn as any).extra.referenceJudgeResult;
      delete (baseMetaForTurn as any).extra.ctxPack.resolvedAsk;
      delete (baseMetaForTurn as any).extra.ctxPack.resolvedAskType;
      delete (baseMetaForTurn as any).extra.ctxPack.referenceJudgeSeed;
      delete (baseMetaForTurn as any).extra.ctxPack.referenceJudgeResult;
      delete (baseMetaForTurn as any).extra.ctxPack.referenceJudge;

      if (String((baseMetaForTurn as any).extra.ctxPack.continuityKind ?? '').trim() === 'reference_check') {
        delete (baseMetaForTurn as any).extra.ctxPack.continuityKind;
      }

      (baseMetaForTurn as any).extra.ctxPack.newQuotedReferenceSource = true;
      (baseMetaForTurn as any).extra.ctxPack.situationSummary = currentTextForStaleCreativeClear;
      (baseMetaForTurn as any).extra.ctxPack.situationTopic = currentTextForStaleCreativeClear;

      console.log(
        '[IROS/STALE_REFERENCE_CHECK_CLEARED]',
        JSON.stringify({
          enabled: true,
          sourceUserText: currentTextForStaleCreativeClear.slice(0, 160),
          staleResolvedAskType,
        }),
      );
    }

    if (isPreviousReplyStyleRewriteText && staleResolvedAskType === 'creative_continuation') {
      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      delete (baseMetaForTurn as any).extra.resolvedAsk;
      delete (baseMetaForTurn as any).extra.ctxPack.resolvedAsk;
      delete (baseMetaForTurn as any).extra.ctxPack.resolvedAskType;

      if (String((baseMetaForTurn as any).extra.ctxPack.continuityKind ?? '').trim() === 'creative_continuation') {
        (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'previous_reply_rephrase';
      }

      (baseMetaForTurn as any).extra.ctxPack.previousReplyStyleRewrite = true;
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        '直前assistant返答のスタイル書き直し。現在のユーザー文そのものを分析せず、直前assistant返答を対象にする。';
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        '直前assistant返答の書き直し';

      console.log(
        '[IROS/STALE_CREATIVE_CONTINUATION_CLEARED]',
        JSON.stringify({
          enabled: true,
          sourceUserText: currentTextForStaleCreativeClear.slice(0, 120),
          staleResolvedAskType,
        }),
      );
    }
  } catch {
    // 補完に失敗しても通常会話は止めない
  }

  // ✅ 直前Mu発話への参照質問を、通常会話の「意味補足」として補完する
  // 例:
  // assistant: 黙って飲み込むより、短く境界を置くほうがいいです。
  // user: それはどういう意味ですか？
  // => ユーザー発話そのものを診断せず、直前Mu発話の抽象表現を現在文脈に戻して説明する
  try {
    const currentTextForReference = String(text ?? '').trim();

    const historyForReference =
      (baseMetaForTurn as any)?.extra?.ctxPack?.historyForWriter ??
      (baseMetaForTurn as any)?.extra?.historyForWriter ??
      (args as any)?.history ??
      [];

    const lastAssistantFromHistoryForReference = Array.isArray(historyForReference)
      ? (() => {
          const found = [...historyForReference]
            .reverse()
            .find((turn: any) => String(turn?.role ?? '').toLowerCase().trim() === 'assistant');

          return (
            (typeof (found as any)?.content === 'string' && String((found as any).content).trim()) ||
            (typeof (found as any)?.text === 'string' && String((found as any).text).trim()) ||
            (typeof (found as any)?.message === 'string' && String((found as any).message).trim()) ||
            ''
          );
        })()
      : '';

    const lastAssistantForReference = (
      String(lastAssistantFromHistoryForReference ?? '').trim() ||
      String(latestAssistantCore ?? '').trim()
    );

    const isReferenceMeaningQuestion =
      /(それ|その|その言葉|その意味|それって|それは|今の|さっきの|先ほどの|この意味)/.test(
        currentTextForReference,
      ) &&
      /(どういう意味|どういうこと|何を指して|なにを指して|意味ですか|意味は|つまり|要するに|って何|とは)/.test(
        currentTextForReference,
      );

    if (isReferenceMeaningQuestion && lastAssistantForReference) {
      const resolvedAsk = {
        askType: 'reference_clarification',
        topic:
          '直前のMu発話に含まれる抽象表現・比喩・提案の意味を、現在の相談文脈に戻して説明する。ユーザー発話そのものを診断しない。',
        sourceUserText: currentTextForReference,
        sourceAssistantText: lastAssistantForReference.slice(0, 500),
      };

      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.referenceClarification = true;
      (baseMetaForTurn as any).extra.resolvedAsk = resolvedAsk;

      (baseMetaForTurn as any).extra.ctxPack.referenceClarification = true;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAskType = 'reference_clarification';
      (baseMetaForTurn as any).extra.ctxPack.goalKind = 'clarify';
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'clarify' };
      (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'reference_clarification';
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        '直前のMu発話の意味補足。ユーザー発話そのものではなく、直前Mu発話の抽象表現を説明する。';
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        '直前Mu発話の意味補足';

      console.log(
        '[IROS/REFERENCE_CLARIFICATION]',
        JSON.stringify({
          enabled: true,
          sourceUserText: currentTextForReference.slice(0, 120),
          sourceAssistantText: lastAssistantForReference.slice(0, 160),
        }),
      );
    }
  } catch {
    // 補完に失敗しても通常会話は止めない
  }

  // ✅ 創作・物語化・書き直しの継続要求を、直前イベントへ接続する
  // 例:
  // assistant: 必要なら次に、この闇を物語としてやわらかく書き起こせます。
  // user: はい、書いてください
  // user: もう少しリアルに書いてください
  // => ユーザー発話そのものを診断せず、直前の創作対象を継続・書き直しとして扱う
  try {
    const currentTextForCreativeContinuation = String(text ?? '').trim();

    const historyForCreativeContinuation =
      (baseMetaForTurn as any)?.extra?.ctxPack?.historyForWriter ??
      (baseMetaForTurn as any)?.extra?.historyForWriter ??
      (args as any)?.history ??
      [];

    const pickLastByRole = (historyLike: any, roleName: 'user' | 'assistant'): string => {
      if (!Array.isArray(historyLike)) return '';

      const found = [...historyLike]
        .reverse()
        .find((turn: any) => String(turn?.role ?? '').toLowerCase().trim() === roleName);

      return (
        (typeof (found as any)?.content === 'string' && String((found as any).content).trim()) ||
        (typeof (found as any)?.text === 'string' && String((found as any).text).trim()) ||
        (typeof (found as any)?.message === 'string' && String((found as any).message).trim()) ||
        ''
      );
    };

    const lastAssistantForCreativeContinuation =
      pickLastByRole(historyForCreativeContinuation, 'assistant') ||
      pickLastByRole((args as any)?.history, 'assistant') ||
      String(latestAssistantCore ?? '').trim();

    const lastUserForCreativeContinuation =
      pickLastByRole(historyForCreativeContinuation, 'user') ||
      pickLastByRole((args as any)?.history, 'user') ||
      '';

    const isCreativeContinuationRequest =
      /(はい、?書いて|書いてください|書いて下さい|それを書いて|あれを書いて|これを書いて|続きを書いて|続き書いて|書き起こして)/.test(
        currentTextForCreativeContinuation,
      );

    const looksLikeCreativeSource =
      /(物語|闇|先祖|家系|書き起こ|書けます|書きます|リアル|自然文|会話っぽく|土着|生々しく|文章|文)/.test(
        [
          lastAssistantForCreativeContinuation,
          lastUserForCreativeContinuation,
          (baseMetaForTurn as any)?.extra?.ctxPack?.situationSummary,
          (baseMetaForTurn as any)?.extra?.ctxPack?.topicDigest,
        ]
          .map((v) => String(v ?? '').trim())
          .filter(Boolean)
          .join('\n'),
      );

    if (isCreativeContinuationRequest && looksLikeCreativeSource) {
      const resolvedAsk = {
        askType: 'creative_continuation',
        topic:
          '直前の創作・物語化・書き直し要求を継続する。ユーザー発話そのものを診断せず、直前の対象を本文として書く。説明ではなく、完成文・物語本文を出す。',
        sourceUserText: currentTextForCreativeContinuation,
        sourceAssistantText: lastAssistantForCreativeContinuation.slice(0, 700),
        sourcePriorUserText: lastUserForCreativeContinuation.slice(0, 300),
      };

      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAskType = 'creative_continuation';
      (baseMetaForTurn as any).extra.ctxPack.goalKind = 'creative';
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'creative' };
      (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'creative_continuation';
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        '直前の創作・物語化・書き直し要求の継続。説明ではなく本文を書く。';
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        '直前の創作・物語化要求の継続';
      (baseMetaForTurn as any).extra.ctxPack.outputShape =
        'creative_continuation_text';

      console.log(
        '[IROS/CREATIVE_CONTINUATION_RESOLVED]',
        JSON.stringify({
          enabled: true,
          sourceUserText: currentTextForCreativeContinuation.slice(0, 120),
          sourceAssistantText: lastAssistantForCreativeContinuation.slice(0, 160),
          sourcePriorUserText: lastUserForCreativeContinuation.slice(0, 120),
        }),
      );
    }
  } catch {
    // 補完に失敗しても通常会話は止めない
  }

  // ✅ 直前Muの確認質問への短答を、確認質問の回答として補完する
  // 例:
  // assistant: 最後に連絡したのは、あなたからですか？それとも彼からですか？
  // user: わたしです
  // => 「最後に連絡したのはユーザーから」として、連絡不安の続きへ接続する
  try {
    const currentTextForShortAnswer = String(text ?? '').trim();
    const compactShortAnswer = currentTextForShortAnswer
      .replace(/\s+/g, '')
      .replace(/[。．.!！?？…]+$/g, '');

    const pickLastAssistantFromHistory = (historyLike: any): string => {
      if (!Array.isArray(historyLike)) return '';

      const found = [...historyLike]
        .reverse()
        .find((turn: any) => String(turn?.role ?? '').toLowerCase().trim() === 'assistant');

      return (
        (typeof (found as any)?.content === 'string' && String((found as any).content).trim()) ||
        (typeof (found as any)?.text === 'string' && String((found as any).text).trim()) ||
        (typeof (found as any)?.message === 'string' && String((found as any).message).trim()) ||
        ''
      );
    };

    const historyForShortAnswerPrimary =
      (baseMetaForTurn as any)?.extra?.ctxPack?.historyForWriter ??
      (baseMetaForTurn as any)?.extra?.historyForWriter ??
      [];

    const lastAssistantFromHistoryForShortAnswer =
      pickLastAssistantFromHistory(historyForShortAnswerPrimary) ||
      pickLastAssistantFromHistory((args as any)?.history);

    const lastAssistantForShortAnswer = (
      String(lastAssistantFromHistoryForShortAnswer ?? '').trim() ||
      String(latestAssistantCore ?? '').trim()
    );

    const ctxPackForShortAnswer = (baseMetaForTurn as any)?.extra?.ctxPack ?? {};
    const relationshipTextForShortAnswer = [
      ctxPackForShortAnswer?.focusResolution?.domain,
      ctxPackForShortAnswer?.situationTopic,
      ctxPackForShortAnswer?.situationSummary,
      ctxPackForShortAnswer?.conversationLine,
      ctxPackForShortAnswer?.topicDigest,
      ctxPackForShortAnswer?.focus,
      ctxPackForShortAnswer?.resolution,
    ]
      .map((v) => String(v ?? '').trim())
      .filter(Boolean)
      .join('\n');

    const looksLikeRelationshipContactContext =
      /relationship_contact_anxiety|連絡不安|返事|連絡/.test(relationshipTextForShortAnswer);

    const askedLastContactSide =
      /最後に連絡したのは/.test(lastAssistantForShortAnswer) &&
      /(あなたから|彼から|彼女から|相手から|向こうから)/.test(lastAssistantForShortAnswer);

    const pureUserAnswer =
      /^(私|わたし|自分|俺|僕|こちら|こっち|私です|わたしです|自分です|俺です|僕です)$/.test(
        compactShortAnswer,
      );

    const userFromAnswer =
      /^(私|わたし|自分|俺|僕|こちら|こっち)(から|からです)$/.test(compactShortAnswer) ||
      /^最後(は|に)?(私|わたし|自分|俺|僕|こちら|こっち)(から)?(です)?$/.test(
        compactShortAnswer,
      ) ||
      /^最後(の連絡|に連絡したの|に送ったの)?(は)?(私|わたし|自分|こちら|こっち)(から)?(です)?$/.test(
        compactShortAnswer,
      ) ||
      /^最後(は|に|の連絡|に連絡したの|に送ったの)?(私|わたし|自分|こちら|こっち)(から)?(連絡|送信|送り)?(した|しました|済み|済みです)?$/.test(
        compactShortAnswer,
      );

    const partnerFromAnswer =
      /^(彼|彼女|相手|向こう)(から|からです|です)$/.test(compactShortAnswer) ||
      /^最後(は|に)?(彼|彼女|相手|向こう)(から)?(です)?$/.test(compactShortAnswer) ||
      /^最後(の連絡|に連絡したの|に送ったの)?(は)?(彼|彼女|相手|向こう)(から)?(です)?$/.test(
        compactShortAnswer,
      ) ||
      /^最後(は|に|の連絡|に連絡したの|に送ったの)?(彼|彼女|相手|向こう)(から)?(連絡|送信|送り)?(した|しました|済み|済みです)?$/.test(
        compactShortAnswer,
      );

    const hasLastContactAnswerMarker =
      /^最後(は|に|の連絡|に連絡したの|に送ったの)?/.test(compactShortAnswer);

    let lastContactBy: 'user' | 'partner' | null = null;

    if (pureUserAnswer || userFromAnswer) {
      lastContactBy = 'user';
    } else if (partnerFromAnswer) {
      lastContactBy = 'partner';
    }

    const canResolveLastContactAnswer =
      !!lastContactBy &&
      (
        askedLastContactSide ||
        userFromAnswer ||
        partnerFromAnswer ||
        (looksLikeRelationshipContactContext && hasLastContactAnswerMarker)
      );

    if (canResolveLastContactAnswer) {
      const resolvedAsk = {
        askType: 'relationship_last_contact_answer',
        topic:
          lastContactBy === 'user'
            ? '最後に連絡したのはユーザーから。送ったのに返事が来ていない状態として、連絡不安の続きへ接続する。'
            : '最後に連絡したのは相手から。相手の連絡後に次の反応がない状態として、連絡不安の続きへ接続する。',
        sourceUserText: currentTextForShortAnswer,
        sourceAssistantText: lastAssistantForShortAnswer.slice(0, 500),
        lastContactBy,
      };

      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAskType = 'relationship_last_contact_answer';
      (baseMetaForTurn as any).extra.ctxPack.relationshipLastContactBy = lastContactBy;
      (baseMetaForTurn as any).extra.ctxPack.goalKind = 'resonate';
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'resonate' };
      (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'relationship_question_followup';
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        lastContactBy === 'user'
          ? '最後に連絡したのはユーザーから。送ったのに返事が来ていない状態。'
          : '最後に連絡したのは相手から。相手の連絡後に次の反応がない状態。';
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        '恋愛の連絡不安の状況確認';

      // writer 側で「わたしです」を自己表明として読ませず、
      // 直前確認質問への回答として扱わせるための明示メタ
      (baseMetaForTurn as any).extra.ctxPack.relationshipFollowupMode =
        'last_contact_answer';
      (baseMetaForTurn as any).extra.ctxPack.askBackAllowed = true;
      (baseMetaForTurn as any).extra.ctxPack.questionsMax = 1;
      (baseMetaForTurn as any).extra.ctxPack.outputShape =
        'relationship_last_contact_followup';
      (baseMetaForTurn as any).extra.ctxPack.nextAction =
        lastContactBy === 'user'
          ? 'ユーザーから送ったあと返事が来ていない状態として受ける。次は、送ってからどれくらい経っているかを短く確認する。'
          : '相手から連絡があったあと、次の反応がない状態として受ける。次は、どこで止まっているかを短く確認する。';

      console.log(
        '[IROS/RELATIONSHIP_SHORT_ANSWER_RESOLVED]',
        JSON.stringify({
          enabled: true,
          lastContactBy,
          sourceUserText: currentTextForShortAnswer.slice(0, 120),
          sourceAssistantText: lastAssistantForShortAnswer.slice(0, 160),
        }),
      );
    }
  } catch {
    // 補完に失敗しても通常会話は止めない
  }

  // ✅ 直前のMu提案に対する「ください」を、提案の実行として補完する
  // 例:
  // assistant: 必要なら次に、そのまま使える短い文だけ一緒に整えます。
  // user: 使える文ください
  // => 「相手に送る短い文を作る」compose/action として扱う
  try {
    const currentTextForPriorOffer = String(text ?? '').trim();

    const historyForPriorOffer =
      (baseMetaForTurn as any)?.extra?.ctxPack?.historyForWriter ??
      (baseMetaForTurn as any)?.extra?.historyForWriter ??
      (args as any)?.history ??
      [];

    const lastAssistantFromHistoryForPriorOffer = Array.isArray(historyForPriorOffer)
      ? (() => {
          const found = [...historyForPriorOffer]
            .reverse()
            .find((turn: any) => String(turn?.role ?? '').toLowerCase().trim() === 'assistant');

          return (
            (typeof (found as any)?.content === 'string' && String((found as any).content).trim()) ||
            (typeof (found as any)?.text === 'string' && String((found as any).text).trim()) ||
            (typeof (found as any)?.message === 'string' && String((found as any).message).trim()) ||
            ''
          );
        })()
      : '';

    const lastAssistantForPriorOffer = (
      String(latestAssistantCore ?? '').trim() ||
      String(lastAssistantFromHistoryForPriorOffer ?? '').trim()
    );

    const userAcceptsPriorOffer =
      /(ください|下さい|お願いします|お願い|使える文|返信文|LINE文|ライン文|送る文|送信文|返す文|返事文|例文|文ください|文をください)/.test(
        currentTextForPriorOffer,
      );

    const userAsksPriorOfferReference =
      /(それを送る|それ送る|送るのですか|送ればいい|送っていい|送るんですか|おくるんですか|その言葉|その一文|何をすすめ|なにをすすめ|何を進め|なにを進め|どれを送る|どれをおくる|何を送る|なにを送る|何をおくる|なにをおくる|どの言葉|どの文|どの一文)/.test(
        currentTextForPriorOffer,
      );

    const assistantOfferedCompose =
      /(そのまま使える|使える短い文|返信文|LINE文|ライン文|送る文|送信文|返す文|返事文|相手に送る|相手へ送る|例文|文面)/.test(
        lastAssistantForPriorOffer,
      );

    const inputKindForPriorOffer = String((baseMetaForTurn as any)?.inputKind ?? '').trim();

    const userIsStructureDesignRequestForPriorOffer =
      /(今の話|この話|構造|設計|実装|seed|シード|回路|接続|直結|意味に入|意味を作る|内面の説明ではなく|使える形|動く形|TCF|SRI)/u.test(
        currentTextForPriorOffer,
      );

    let hasResolvedPendingOfferFollowup = false;

    const pendingOfferForPriorOffer = (() => {
      const direct =
        (baseMetaForTurn as any)?.extra?.ctxPack?.pendingOffer ??
        (baseMetaForTurn as any)?.extra?.pendingOffer ??
        null;

      if (direct && typeof direct === 'object') return direct;

      if (!Array.isArray(historyForPriorOffer)) return null;

      const found = [...historyForPriorOffer]
        .reverse()
        .find((turn: any) => {
          if (String(turn?.role ?? '').toLowerCase().trim() !== 'assistant') return false;

          const pendingOffer =
            turn?.meta?.extra?.ctxPack?.pendingOffer ??
            turn?.meta?.ctxPack?.pendingOffer ??
            turn?.ctxPack?.pendingOffer ??
            null;

          return (
            pendingOffer &&
            typeof pendingOffer === 'object' &&
            Array.isArray(pendingOffer.options)
          );
        });

      return (
        (found as any)?.meta?.extra?.ctxPack?.pendingOffer ??
        (found as any)?.meta?.ctxPack?.pendingOffer ??
        (found as any)?.ctxPack?.pendingOffer ??
        null
      );
    })();

    const resolvedOfferForPriorOffer = resolvePendingOfferFromUserText({
      userText: currentTextForPriorOffer,
      pendingOffer: pendingOfferForPriorOffer,
    });

    if (
      !userIsStructureDesignRequestForPriorOffer &&
      resolvedOfferForPriorOffer.status === 'resolved' &&
      resolvedOfferForPriorOffer.action
    ) {
      const resolvedAsk = {
        askType: 'offer_followup',
        topic: resolvedOfferForPriorOffer.action,
        sourceUserText: currentTextForPriorOffer,
        sourceAssistantText: lastAssistantForPriorOffer.slice(0, 220),
        selectedLabel: resolvedOfferForPriorOffer.selected.label,
        selectedType: resolvedOfferForPriorOffer.selected.type,
        offerId: resolvedOfferForPriorOffer.offerId,
      };

      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAskType = 'offer_followup';
      (baseMetaForTurn as any).extra.ctxPack.resolvedOffer = resolvedOfferForPriorOffer;
      (baseMetaForTurn as any).extra.ctxPack.goalKind = 'action';
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'action' };
      (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'offer_followup';
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        resolvedOfferForPriorOffer.action.slice(0, 160);
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        resolvedOfferForPriorOffer.targetLabel
          ? resolvedOfferForPriorOffer.targetLabel + 'に関する直前提案の実行'
          : '直前提案の実行';

      hasResolvedPendingOfferFollowup = true;

      console.log(
        '[IROS/OFFER][RESOLVED]',
        JSON.stringify({
          status: resolvedOfferForPriorOffer.status,
          offerId: resolvedOfferForPriorOffer.offerId,
          selected: resolvedOfferForPriorOffer.selected,
          actionHead: String(resolvedOfferForPriorOffer.action ?? '').slice(0, 120),
          targetLabel: resolvedOfferForPriorOffer.targetLabel,
          domain: resolvedOfferForPriorOffer.domain,
          matchedBy: resolvedOfferForPriorOffer.source.matchedBy,
          confidence: resolvedOfferForPriorOffer.source.confidence,
        }),
      );
    }

    if (
      !hasResolvedPendingOfferFollowup &&
      !userIsStructureDesignRequestForPriorOffer &&
      assistantOfferedCompose &&
      (
        (inputKindForPriorOffer === 'task' && userAcceptsPriorOffer) ||
        userAsksPriorOfferReference
      )
    ) {
      const resolvedAsk = {
        askType: 'compose_from_prior_offer',
        topic: '直前のMu提案に基づいて、相手に送る短い文を作る。自分を落ち着かせる保留文ではなく、相手に気持ち・要望・境界線を伝える文にする',
        sourceUserText: currentTextForPriorOffer,
        sourceAssistantText: lastAssistantForPriorOffer.slice(0, 220),
      };

      (baseMetaForTurn as any).extra ??= {};
      (baseMetaForTurn as any).extra.ctxPack ??= {};

      (baseMetaForTurn as any).extra.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAsk = resolvedAsk;
      (baseMetaForTurn as any).extra.ctxPack.resolvedAskType = 'compose_from_prior_offer';
      (baseMetaForTurn as any).extra.ctxPack.goalKind = 'action';
      (baseMetaForTurn as any).extra.ctxPack.replyGoal = { kind: 'action' };
      (baseMetaForTurn as any).extra.ctxPack.continuityKind = 'prior_offer_followup';
      (baseMetaForTurn as any).extra.ctxPack.situationSummary =
        '直前のMu提案に基づいて、相手に送る短い文を作る。自分を落ち着かせる保留文ではなく、相手に気持ち・要望・境界線を伝える文にする';
      (baseMetaForTurn as any).extra.ctxPack.situationTopic =
        '相手に送る短い文';
    }
  } catch {
    // 補完に失敗しても通常会話は止めない
  }

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
