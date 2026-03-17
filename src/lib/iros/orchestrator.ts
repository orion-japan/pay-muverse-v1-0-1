// file: src/lib/iros/orchestrator.ts
// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
// ✅ V2方針：Orchestrator は「判断（meta確定）」のみ。本文生成（LLM）は一切しない。
// - 本文は handleIrosReply 側の render-v2（itWriter含む）が唯一の生成者。

import {
  type IrosMode,
  type Depth,
  type QCode,
  type IrosMeta,
  type TLayer,
  type IrosStyle,
  DEPTH_VALUES,
  QCODE_VALUES,
} from '@/lib/iros/system';

import { clampSelfAcceptance } from './orchestratorMeaning';
import { computeSpinState } from './orchestratorSpin';
import { buildNormalChatSlotPlan } from './slotPlans/normalChat';
import { buildCounselSlotPlan } from './slotPlans/counsel';
import { buildFlagReplySlots } from './slotPlans/flagReply';
import { buildIrDiagnosisSlotPlan } from './slotPlans/irDiagnosis';
import { normalizeIrosMode } from '@/lib/iros/memory/mode';

// 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
import {
  runOrchestratorAnalysis,
  type OrchestratorAnalysisResult,
} from './orchestratorAnalysis';

// Will（Goal / Priority）
import {
  computeGoalAndPriority,
  type IrosGoalType,
  type IrosPriorityType,
} from './orchestratorWill';

// モード決定（mirror / vision / diagnosis）
import { applyModeToMeta } from './orchestratorMode';

// ★ 今日できること？トリガー検出
import { detectActionRequest } from './will/detectActionRequest';

// delegate intent override
import { applyDelegateIntentOverride } from './will/delegateIntentOverride';

// -------- 分割済み（A/C/D/E/I/J/Soul） --------
import { resolveBaseMeta } from './orchestratorBaseMeta';
import { applySpinControlAndAnchorEvent } from './orchestratorSpinControl';
import { applyFullAuto } from './orchestratorFullAuto';
import { applyVisionTrigger } from './orchestratorVisionTrigger';
import { applyIntentTransitionV1 } from './orchestratorIntentTransition';
import { applyIntentBridge } from './intentTransition/intentBridge';
import { decidePlaceholderGate } from './intentTransition/placeholderGate';
import { applyContainerDecision } from './orchestratorContainer';
import { applySoul } from './orchestratorSoul';

// IT Trigger
import { computeITTrigger } from '@/lib/iros/rotation/computeITTrigger';
import { detectIMode } from './iMode';

import { extractAnchorEvidence } from '@/lib/iros/anchor/extractAnchorEvidence';
import { detectAnchorEntry } from '@/lib/iros/anchor/AnchorEntryDetector';
import { observeFlow } from '@/lib/iros/input/flowObserver';
import { computeStallSignal } from '@/lib/iros/conversation/stallProbe';
import { shouldUseQuestionSlots } from './slotPlans/QuestionSlots';
import { runQuestionEngine } from './question';

// Person Intent Memory（ir診断）
import { savePersonIntentState } from './memory/savePersonIntent';
import { diagnosisEngine } from './diagnosis/diagnosisEngine';

// ==== 固定アンカー（北） ====
// - ユーザー発話から抽出しない
// - 常に「太陽SUN」を北として持つ
const FIXED_NORTH = {
  key: 'SUN',
  text: '太陽SUN',
  phrase: '成長 / 進化 / 希望 / 歓喜',
} as const;

// ==== I層強制モード（ENV） ====
//   - true のとき、requestedDepth を優先して depth を固定する
const FORCE_I_LAYER =
  typeof process !== 'undefined' &&
  process.env.IROS_FORCE_I_LAYER === '1';

export type IrosOrchestratorArgs = {
  conversationId?: string;
  text: string;

  requestedMode?: IrosMode;
  requestedDepth?: Depth;
  requestedQCode?: QCode;

  baseMeta?: Partial<IrosMeta>;

  /** ★ この会話の最初のターンかどうか（reply/route.ts から渡す） */
  isFirstTurn?: boolean;

  /** ★ MemoryState 読み書き用：user_code */
  userCode?: string;

  // ✅ 追加：supabase client（変数名は sb で固定）
  sb: any;

  /** ★ v. iros user_profile の行データ（任意） */
  userProfile?: Record<string, any> | null;

  /** ★ 口調スタイル（route / handleIrosReply から渡す） */
  style?: IrosStyle | string | null;

  /** ✅ NEW: ITDemoGate / repeat 用の履歴（handleIrosReply 側で渡せる） */
  history?: unknown[];
};

// ==== Orchestrator から返す結果 ==== //
// ✅ V2では content は render-v2 が作る。Orchestrator は空文字を返す（互換のため保持）
export type IrosOrchestratorResult = {
  content: string; // V2では "" を返す
  meta: IrosMeta;
};

/* ============================================================================
 * S4（幽霊値）対策：Depth 正規化ユーティリティ
 * - どこから S4 が来ても「F1」に丸める
 * - それ以外は DEPTH_VALUES の範囲だけ通す
 * ========================================================================== */
function normalizeDepthStrict(depth?: Depth | null): Depth | undefined {
  if (!depth) return undefined;
  if (depth === 'S4') return 'F1' as Depth;
  return DEPTH_VALUES.includes(depth) ? depth : undefined;
}

function normalizeDepthStrictOrNull(depth?: Depth | null): Depth | null {
  return normalizeDepthStrict(depth) ?? null;
}

/* ============================================================================
 * 補助：Depth / QCode 正規化
 * ========================================================================== */

function determineInitialDepth(
  requestedDepth?: Depth,
  baseDepth?: Depth,
): Depth | undefined {
  // I層固定モードのときは、I1〜I3 を優先的に使う
  if (FORCE_I_LAYER) {
    if (requestedDepth && requestedDepth.startsWith('I')) return requestedDepth;
    if (baseDepth && baseDepth.startsWith('I')) return baseDepth;
    return 'I2';
  }
  return requestedDepth ?? baseDepth;
}

function normalizeQCode(qCode?: QCode): QCode | undefined {
  if (!qCode) return undefined;
  return QCODE_VALUES.includes(qCode) ? qCode : undefined;
}

/* ============================================================================
 * ✅ intent_anchor 正規化（camel/snake/文字列/オブジェクトの揺れを吸う）
 * - 返すのは「metaに載せる正規形」だけ（persist側の期待に合わせるため）
 * - ここでは “意味” を作らない。あるものを整形して渡すだけ。
 * ========================================================================== */
type IntentAnchorNormalized =
  | { key: string; text?: string | null; phrase?: string | null }
  | null;

function normalizeIntentAnchor(raw: unknown): IntentAnchorNormalized {
  if (raw == null) return null;

  // 文字列（例：'SUN'）は {key:'SUN'} に正規化
  if (typeof raw === 'string') {
    const k = raw.trim();
    if (!k) return null;
    return { key: k };
  }

  // 既に {key:'SUN'} 形式
  if (typeof raw === 'object') {
    const any = raw as any;
    const keyRaw = any?.key ?? any?.Key ?? any?.KEY ?? null;
    const key =
      typeof keyRaw === 'string' && keyRaw.trim().length > 0
        ? keyRaw.trim()
        : null;
    if (!key) return null;

    const text =
      typeof any?.text === 'string' && any.text.trim().length > 0
        ? any.text.trim()
        : null;

    const phrase =
      typeof any?.phrase === 'string' && any.phrase.trim().length > 0
        ? any.phrase.trim()
        : null;

    return { key, text, phrase };
  }

  return null;
}

// Iros Orchestrator — Will Engine（Goal / Priority）+ Continuity Engine 統合版
export async function runIrosTurn(
  args: IrosOrchestratorArgs,
): Promise<IrosOrchestratorResult> {
  const {
    conversationId,
    text,
    sb,
    requestedMode,
    requestedDepth,
    requestedQCode,
    baseMeta,
    isFirstTurn,
    userCode,
    userProfile,
    style,
    history,
  } = args;

  // ----------------------------------------------------------------
  // A) BaseMeta / Memory / Continuity 準備
  // ----------------------------------------------------------------
  const base = await resolveBaseMeta({
    sb,
    userCode,
    baseMeta,
    style,
    normalizeDepthStrict,
    normalizeQCode,
  });

  const mergedBaseMeta: Partial<IrosMeta> = base.mergedBaseMeta;
  const memoryState: unknown = base.memoryState;

  const ms: any = base.ms ?? null;
  const lastDepthForContinuity = base.lastDepthForContinuity;
  const lastQForContinuity = base.lastQForContinuity;

  const lastSpinLoop = base.lastSpinLoop;
  const lastSpinStep = base.lastSpinStep;
  const lastPhaseForSpin = base.lastPhaseForSpin;

  const lastVolatilityRank = base.lastVolatilityRank;
  const lastDescentGate = base.lastDescentGate;

  const lastGoalKind = base.lastGoalKind;
  const previousUncoverStreak = base.previousUncoverStreak;

  // depth / qCode の初期値決定
  const initialDepth = determineInitialDepth(
    requestedDepth,
    mergedBaseMeta.depth as Depth | undefined,
  );
  const initialQCode = (requestedQCode as QCode | undefined) ?? undefined;

  const normalizedDepth = normalizeDepthStrict(initialDepth);
  const normalizedQCode = normalizeQCode(initialQCode);

  // ----------------------------------------------------------------
  // 3. 解析フェーズ（Unified / depth / Q / SA / YH / IntentLine / T層）
  // ----------------------------------------------------------------
  const analysis: OrchestratorAnalysisResult = await runOrchestratorAnalysis({
    text,
    requestedDepth: normalizedDepth,
    requestedQCode: normalizedQCode,
    baseMeta: mergedBaseMeta,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    memoryState: memoryState as any,
    isFirstTurn: !!isFirstTurn,
  });

  // --- Iモード判定（ここで一度だけ） ---
  const iMode = detectIMode({
    text,
    force: false,
  });

  // --------------------------------------------------
  // 解析結果の展開
  // --------------------------------------------------
  let {
    depth,
    qCode: resolvedQCode,
    selfAcceptanceLine,
    unified,
    yLevel,
    hLevel,
    intentLine,
    tLayerHint,
    hasFutureMemory,
    qTrace,
    tLayerModeActive,
  } = analysis;

  const observedPrimaryStage =
    ((unified as any)?.observed?.primaryStage as Depth | null | undefined) ?? null;
  const observedSecondaryStage =
    ((unified as any)?.observed?.secondaryStage as Depth | null | undefined) ?? null;
  const observedStage =
    ((unified as any)?.observed?.observedStage as Depth | null | undefined) ?? null;
  const observedPrimaryBand =
    ((unified as any)?.observed?.primaryBand as string | null | undefined) ?? null;
  const observedSecondaryBand =
    ((unified as any)?.observed?.secondaryBand as string | null | undefined) ?? null;
  const observedPrimaryDepth =
    ((unified as any)?.observed?.primaryDepth as 1 | 2 | 3 | null | undefined) ?? null;
  const observedSecondaryDepth =
    ((unified as any)?.observed?.secondaryDepth as 1 | 2 | 3 | null | undefined) ?? null;
  const observedBasedOn =
    ((unified as any)?.observed?.basedOn as string | null | undefined) ?? null;

  // -------------------------------
  // Iモード時の上書き（※深度は変えない）
  // -------------------------------
  if (iMode.enabled) {
    (analysis as any).renderVoice = 'I';
    (analysis as any).intentLock = true;

    // 明示的に「T層ではない」ことを保証
    tLayerHint = null;
    hasFutureMemory = false;
  }

  // -------------------------------
  // 正規化
  // -------------------------------
  const normalizedTLayer: TLayer | null =
    tLayerHint === 'T1' || tLayerHint === 'T2' || tLayerHint === 'T3'
      ? (tLayerHint as TLayer)
      : null;

  const analyzedDepth: Depth | undefined =
    normalizeDepthStrict(depth as Depth | undefined) ?? normalizedDepth;

  // ----------------------------------------------------------------
  // 4. meta 初期化（解析結果を反映）
  // ----------------------------------------------------------------
  let meta: IrosMeta = {
    ...(mergedBaseMeta as IrosMeta),

    unified: (unified as any) ?? (mergedBaseMeta as any).unified ?? null,

    // 優先：analysis > 継続（前回） > 既定値（S2）
    depth: analyzedDepth ?? lastDepthForContinuity ?? ('S2' as Depth),

    // 優先：analysis > 明示指定 > 継続（lastQ）
    qCode: resolvedQCode ?? normalizedQCode ?? lastQForContinuity ?? undefined,

    selfAcceptance:
      typeof selfAcceptanceLine === 'number'
        ? clampSelfAcceptance(selfAcceptanceLine)
        : mergedBaseMeta.selfAcceptance ?? null,

        yLevel: typeof yLevel === 'number' ? yLevel : mergedBaseMeta.yLevel ?? null,
        hLevel: typeof hLevel === 'number' ? hLevel : mergedBaseMeta.hLevel ?? null,

    intentLine: intentLine ?? mergedBaseMeta.intentLine ?? null,
    tLayerHint: normalizedTLayer ?? mergedBaseMeta.tLayerHint ?? null,

    hasFutureMemory,
  };

  (meta as any).primaryStage = observedPrimaryStage;
  (meta as any).secondaryStage = observedSecondaryStage;
  (meta as any).observedStage = observedStage;
  (meta as any).primaryBand = observedPrimaryBand;
  (meta as any).secondaryBand = observedSecondaryBand;
  (meta as any).primaryDepth = observedPrimaryDepth;
  (meta as any).secondaryDepth = observedSecondaryDepth;
  (meta as any).observedBasedOn = observedBasedOn;

  // Phase（Unified または baseMeta から採用）
  {
    let phase: 'Inner' | 'Outer' | null = null;

    const unifiedPhaseRaw =
      (unified?.phase as string | undefined) ??
      ((mergedBaseMeta as any)?.phase as string | undefined) ??
      null;

    if (typeof unifiedPhaseRaw === 'string') {
      const p = unifiedPhaseRaw.trim().toLowerCase();
      if (p === 'inner') phase = 'Inner';
      else if (p === 'outer') phase = 'Outer';
    }
    (meta as any).phase = phase;
  }

  // qTrace（analysis由来）を載せる
  if (qTrace) {
    (meta as any).qTrace = qTrace;
    (meta as any).qTraceUpdated = qTrace;
  }

  if (tLayerModeActive) {
    (meta as any).tLayerModeActive = true;
  }

  // userProfile を meta に載せる（明示が優先）
  if (typeof userProfile !== 'undefined') {
    (meta as any).userProfile = userProfile;
  }

  // userCallName 解決
  {
    const profileForName: Record<string, any> | null =
      (typeof userProfile !== 'undefined' && userProfile) ||
      ((meta as any).userProfile as Record<string, any> | null | undefined) ||
      null;

    if (profileForName) {
      const callNameRaw =
        (profileForName.ai_call_name as string | null | undefined) ??
        (profileForName.display_name as string | null | undefined) ??
        null;

      const callName =
        typeof callNameRaw === 'string' && callNameRaw.trim().length > 0
          ? callNameRaw.trim()
          : null;

      if (callName) {
        (meta as any).userCallName = callName;
      }
    }
  }

  // =========================================================
  // [IROS_FIXED_NORTH_BLOCK] 固定北（SUN）: meta.fixedNorth のみに保持
  // =========================================================
  {
    (meta as any).fixedNorth = FIXED_NORTH;
  }

  // =========================================================
  // ✅ [PHASE11 FIX] intent_anchor を meta に「正式キー」として載せる（LLM/Writer/Orch観測用）
  // - DB/MemoryState に既に入っている intent_anchor を “metaへ反映” する
  // - 形ゆれ（string/object, snake/camel）を吸って「正規形」にする
  // - ここでは “固定北” と “intent_anchor” を混同しない（別キー）
  // - ✅ Orchestrator が見る camel キー（intentAnchorKey / hasIntentAnchor）も必ず張る
  // =========================================================
  {
    const fromBase =
      (mergedBaseMeta as any)?.intent_anchor ??
      (mergedBaseMeta as any)?.intentAnchor ??
      null;

    const fromMemory =
      (ms as any)?.intent_anchor ??
      (ms as any)?.intentAnchor ??
      (memoryState as any)?.intent_anchor ??
      (memoryState as any)?.intentAnchor ??
      null;

    const already =
      (meta as any)?.intent_anchor ?? (meta as any)?.intentAnchor ?? null;

    const normalized =
      normalizeIntentAnchor(already) ??
      normalizeIntentAnchor(fromBase) ??
      normalizeIntentAnchor(fromMemory) ??
      null;

    const key =
      normalized && typeof (normalized as any).key === 'string'
        ? (normalized as any).key
        : null;

    // ✅ single source of truth（camel + snake を同時に張る）
    (meta as any).intent_anchor = normalized;
    (meta as any).intentAnchor = normalized;

    // ✅ key も camel + snake
    (meta as any).intent_anchor_key = key;
    (meta as any).intentAnchorKey = key;

    // ✅ Orchestrator の観測用（ログの hasIntentAnchor を一致させる）
    (meta as any).hasIntentAnchor = !!key;
  }

  // ----------------------------------------------------------------
  // C) 揺らぎ×ヒステリシス → 回転ギア確定（metaに反映）
  // ----------------------------------------------------------------
  meta = applySpinControlAndAnchorEvent({
    meta,
    lastVolatilityRank,
  });

  // ----------------------------------------------------------------
  // 4.5 Soul レイヤー（meta補完 + topic抽出 + soulNote格納）
  // ----------------------------------------------------------------
  {
    const soul = await applySoul({
      text,
      meta,
      intentLine: intentLine ?? null,
      yLevel: typeof yLevel === 'number' ? yLevel : null,
      hLevel: typeof hLevel === 'number' ? hLevel : null,
      unified: unified ?? null,
    });

    meta = soul.meta;
    if (soul.situationTopic) {
      (meta as any).situationTopic = soul.situationTopic;
    }
  }

  // ----------------------------------------------------------------
  // D) FullAuto / FeatureFlag 集約 → meta.fullAuto
  // ----------------------------------------------------------------
  {
    const r = applyFullAuto({ userCode: userCode ?? null, meta: meta as any });
    meta = r.meta as any;
  }

  // ----------------------------------------------------------------
  // 5. Vision-Trigger 判定（ビジョンモードへの自動ジャンプ）
  // ----------------------------------------------------------------
  {
    const vr = applyVisionTrigger({ text, meta });
    meta = vr.meta;
    meta.depth = normalizeDepthStrict(meta.depth as any);
  }

  // ----------------------------------------------------------------
  // 6. モード決定（mirror / vision / diagnosis）
  // ----------------------------------------------------------------
  meta = applyModeToMeta(text, {
    requestedMode,
    meta,
    isFirstTurn: !!isFirstTurn,
    intentLine: ((meta as any).intentLine ?? intentLine) ?? null,
    tLayerHint: normalizedTLayer,
    forceILayer: FORCE_I_LAYER,
  });

  if (meta.mode !== 'vision' && meta.tLayerHint) {
    (meta as any).tLayerModeActive = true;
  }

  // ----------------------------------------------------------------
  // 7. Will フェーズ：Goal / Priority の決定
  // ----------------------------------------------------------------
  let { goal, priority } = computeGoalAndPriority({
    conversationId: conversationId ?? null, // ✅ 追加（DEPTH_WRITE に渡す）

    text,
    depth: meta.depth,
    qCode: meta.qCode,
    lastDepth: lastDepthForContinuity ?? undefined,
    lastQ: lastQForContinuity ?? undefined,
    selfAcceptanceLine: meta.selfAcceptance ?? null,
    mode: (meta.mode ?? 'mirror') as IrosMode,
    soulNote: (meta as any).soulNote ?? null,
    lastGoalKind: (lastGoalKind ?? undefined) as any,
    previousUncoverStreak,
    phase: (meta as any).phase ?? null,
    spinLoop:
      (typeof lastSpinLoop !== 'undefined' ? lastSpinLoop : null) ?? null,
    descentGate:
      (typeof lastDescentGate !== 'undefined' ? lastDescentGate : null) ?? null,
  });


  // targetQ が undefined に落ちるケースを補正
  {
    const q = meta.qCode ?? null;
    if (q) {
      if (goal && (goal as any).targetQ == null) (goal as any).targetQ = q;
      if (priority?.goal && (priority.goal as any).targetQ == null) {
        (priority.goal as any).targetQ = q;
      }
    }
  }

  // meta.rotationState.reason の欠落防止
  {
    const g: any = goal as any;
    const rs = g?.rotationState ?? null;

    (meta as any).rotationState = {
      spinLoop:
        (rs && typeof rs.spinLoop === 'string' ? rs.spinLoop : null) ??
        ((meta as any).spinLoop ?? null),
      descentGate:
        (rs && typeof rs.descentGate === 'string' ? rs.descentGate : null) ??
        ((meta as any).descentGate ?? null),
      depth:
        (rs && typeof rs.depth === 'string' ? rs.depth : null) ??
        ((meta as any).depth ?? null),
      reason:
        (rs && typeof rs.reason === 'string' ? rs.reason : null) ??
        'rotationState: reason not provided',
    };
  }

  // delegate intent 上書き（デモ寄せ：フラグで制御）
  {
    const enableDelegateOverride =
      process.env.IROS_ENABLE_DELEGATE_OVERRIDE === '1';

    if (enableDelegateOverride && goal && priority) {
      ({ goal, priority } = applyDelegateIntentOverride({
        goal,
        priority,
        text,
        meta,
      }));
    }

    const isDelegateIntent =
      !!(priority as any)?.debugNote &&
      String((priority as any).debugNote).includes('delegateIntent');

    if (isDelegateIntent) {
      (meta as any).noQuestion = true;
      (meta as any).replyStyleHint = 'no-question-action-first';
    }
  }

  // 「今日できること？」などの行動要求
  {
    const isActionRequest = detectActionRequest(text);

    if (isActionRequest && priority) {
      const anyPriority = priority as any;
      const weights = { ...(anyPriority.weights || {}) };

      weights.forward = Math.max(weights.forward ?? 0, 0.8);
      weights.mirror = Math.min(weights.mirror ?? 0.8, 0.7);

      anyPriority.weights = weights;
      anyPriority.debugNote = anyPriority.debugNote
        ? `${anyPriority.debugNote} +actionRequest`
        : 'actionRequest';

      priority = anyPriority as IrosPriorityType;

      if (goal) {
        const anyGoal = goal as any;
        if (!anyGoal.reason) {
          anyGoal.reason =
            'ユーザーが「今日できること？」と具体的な一歩を求めているため、forward を優先';
        }
        goal = anyGoal as IrosGoalType;
      }
    }
  }

  // =========================================================
  // ✅ [PHASE11 FIX] itx_* を meta に同期（prevIt_fromMeta を復活させる）
  // - 主ソースは MemoryState(ms) / memoryState
  // - “camel + snake” を同時に張る（矛盾ゼロ）
  // - ここでは意味生成しない：既にある値を meta に載せるだけ
  // - computeITTrigger の前に必ず実行する
  // =========================================================
  {
    const fromMs =
      (ms as any)?.itx_step ??
      (ms as any)?.itxStep ??
      (memoryState as any)?.itx_step ??
      (memoryState as any)?.itxStep ??
      null;

    const fromReason =
      (ms as any)?.itx_reason ??
      (ms as any)?.itxReason ??
      (memoryState as any)?.itx_reason ??
      (memoryState as any)?.itxReason ??
      null;

    const fromLastAt =
      (ms as any)?.itx_last_at ??
      (ms as any)?.itxLastAt ??
      (memoryState as any)?.itx_last_at ??
      (memoryState as any)?.itxLastAt ??
      null;

    // すでに meta にあるなら meta 優先（ただし空は上書き）
    const stepNow = (meta as any)?.itx_step ?? (meta as any)?.itxStep ?? null;

    const reasonNow =
      (meta as any)?.itx_reason ?? (meta as any)?.itxReason ?? null;

    const lastAtNow =
      (meta as any)?.itx_last_at ?? (meta as any)?.itxLastAt ?? null;

    const stepFinal = stepNow || fromMs || null;
    const reasonFinal = reasonNow || fromReason || null;
    const lastAtFinal = lastAtNow || fromLastAt || null;

    // ✅ camel + snake で同期
    (meta as any).itx_step = stepFinal;
    (meta as any).itxStep = stepFinal;

    (meta as any).itx_reason = reasonFinal;
    (meta as any).itxReason = reasonFinal;

    (meta as any).itx_last_at = lastAtFinal;
    (meta as any).itxLastAt = lastAtFinal;

    // ✅ ログ用：persistReason を“確定値”から必ず作る（誤読不能化）
    (meta as any).itxPersistReason = reasonFinal;
    (meta as any).itx_persist_reason = reasonFinal;

    // ✅ prevIt_fromMeta.active の材料：IT_TRIGGER_OK が見えていれば active 扱い
// ✅ prevIt_fromMeta.active の材料：IT_TRIGGER_OK が見えていれば「過去由来の active」扱い
const prevActive =
  typeof reasonFinal === 'string' && reasonFinal.includes('IT_TRIGGER_OK');

// 🔒 ここでは itTriggered を上書きしない（このターンの itOk が担当）
// - 代わりに「過去由来」を明示名で保持して誤読不能化
(meta as any).prevItTriggered = prevActive;
(meta as any).prev_it_triggered = prevActive;

  }

  // ----------------------------------------------------------------
  // 7.75 IT Trigger（I→T の扉） + I語彙の表出許可
  // ----------------------------------------------------------------
  {
    const historyArr = Array.isArray(history) ? (history as any[]) : [];

    const normHistoryArr: any[] = [];
    for (const m of historyArr) {
      const role = String(m?.role ?? '').toLowerCase();
      const raw = m?.text ?? m?.content ?? null;
      const txt = typeof raw === 'string' ? raw.replace(/\r\n/g, '\n').trim() : null;

      const last = normHistoryArr.length > 0 ? normHistoryArr[normHistoryArr.length - 1] : null;
      const lastRole = String(last?.role ?? '').toLowerCase();
      const lastTextRaw = last?.text ?? last?.content ?? null;
      const lastTxt =
        typeof lastTextRaw === 'string' ? lastTextRaw.replace(/\r\n/g, '\n').trim() : null;

      if (role === 'user' && lastRole === 'user' && txt && lastTxt && txt === lastTxt) {
        continue;
      }

      normHistoryArr.push(m);
    }
    const userHistory = normHistoryArr.filter((m) => {
      const role = String(m?.role ?? '').toLowerCase();
      return role === 'user';
    });

    const last3User = userHistory.slice(-3).map((m: any) => {
      const v = m?.text ?? m?.content ?? null;
      return typeof v === 'string' ? v : null;
    });

    if (
      typeof process !== 'undefined' &&
      process.env.DEBUG_IROS_IT === '1' &&
      (!process.env.DEBUG_USER ||
        process.env.DEBUG_USER ===
          String((meta as any)?.userCode ?? (meta as any)?.user_code ?? ''))
    ) {
      console.log('[IROS/IT][probe] before', {
        textHead: (text || '').slice(0, 80),
        historyLen: historyArr.length,
        historyLen_norm: normHistoryArr.length, // ✅ 追加：正規化後の長さ
        historyUserLen: userHistory.length,
        last3User,
        depth: meta.depth ?? null,
        intentLine: (meta as any).intentLine ?? null,
        fixedNorth: (meta as any).fixedNorth ?? null,
        intent_anchor: (meta as any).intent_anchor ?? null,
      });
    }

    const it = computeITTrigger({
      text,
      history: normHistoryArr, // ✅ ここ重要：正規化した history を渡す
      meta,
      memoryState: (memoryState ?? null) as any,
    });

    console.log('[IROS/IT][result]', {
      ok: it.ok,
      reason: it.reason,
      flags: it.flags,
      tLayerModeActive: it.tLayerModeActive,
      tLayerHint: it.tLayerHint,
      tVector: it.tVector,
    });

    // =========================================================
    // ✅ Single source：IT結果を “camel + snake” に同時反映（矛盾ゼロ）
    // =========================================================
    // ✅ 今ターンの「扉(itOk)」は reason で決める
    // - 通常は IT_TRIGGER_OK のときだけ true
    // - ただし今回は試験的に、
    //   確定済みT3 + IT_ALREADY_COMMITTED のときだけ carry-open を許す
    const itReason = it.reason ?? null;

    const committedStep =
      (meta as any)?.itx_step ??
      (meta as any)?.itxStep ??
      (ms as any)?.itx_step ??
      (ms as any)?.itxStep ??
      null;

    const isCommittedT3 = committedStep === 'T3';

    const carryOpenCommittedT3 =
      isCommittedT3 && it.ok === true && it.reason === 'IT_ALREADY_COMMITTED';

    const itOk =
      (it.ok === true && it.reason === 'IT_TRIGGER_OK') ||
      carryOpenCommittedT3;

    // ✅ IT flags を meta に露出（IntentBridge の lane 判定入力に使う）
    // - ここが無いと hasCore/deepenOk が downstream で常に false/null になる
    {
      const flagsNow = (it as any)?.flags ?? null;

      const itTriggerObj =
        typeof (meta as any).itTrigger === 'object' && (meta as any).itTrigger
          ? (meta as any).itTrigger
          : ((meta as any).itTrigger = {});
      itTriggerObj.flags = flagsNow;

      const itTriggerObjSnake =
        typeof (meta as any).it_trigger === 'object' && (meta as any).it_trigger
          ? (meta as any).it_trigger
          : ((meta as any).it_trigger = {});
      itTriggerObjSnake.flags = flagsNow;
    }

    // ✅ IntentBridge が拾う入力（meta.itTrigger.flags）をここで必ず供給する
    // - ok は「今ターンの扉(itOk)」
    (meta as any).itTrigger = {
      ok: itOk,
      reason: itReason,
      flags: (it as any).flags ?? null,
      tLayerModeActive:
        carryOpenCommittedT3 ? true : (it as any).tLayerModeActive === true,
      tLayerHint:
        carryOpenCommittedT3
          ? ((it as any).tLayerHint ?? 'T3')
          : ((it as any).tLayerHint ?? null),
      tVector: (it as any).tVector ?? null,
    };

    // ✅ T3確定（commit済み）なら：probe で確定領域は上書きしない
    // ただし今回は carry-open のときだけ「表現用の扉」を開ける
    if (isCommittedT3) {
      // ✅ 再発防止ログ用：そのターンの判定理由（確定状態は維持）
      (meta as any).itxDecisionReason = itReason;
      (meta as any).itx_decision_reason = itReason;

      // 既存キー（互換）：probe理由として退避
      (meta as any).itx_probe_reason = itReason;

      // ✅ 確定済みT3なので keep（確定領域に触らない）
      (meta as any).itxWriteMode = 'keep';
      (meta as any).itx_write_mode = 'keep';

      // ✅ carry-open のときだけ今ターンの扉を開く
      (meta as any).itTriggered = carryOpenCommittedT3;
      (meta as any).it_triggered = carryOpenCommittedT3;

      // itxReason / itx_reason は「確定値」を維持（ここでは代入しない）
    } else {
      // ✅ 再発防止ログ用：そのターンの判定理由
      (meta as any).itxDecisionReason = itReason;
      (meta as any).itx_decision_reason = itReason;

      // ✅ このターンの itx 扱い
      // - itOk が true のときだけ commit（扉が開いた）
      // - itOk が false のときは keep（確定領域に触らない）
      const writeMode = itOk ? 'commit' : 'keep';
      (meta as any).itxWriteMode = writeMode;
      (meta as any).itx_write_mode = writeMode;

      (meta as any).itTriggered = itOk;
      (meta as any).it_triggered = itOk;

      // ✅ “確定値(itx_reason)” は commit のときだけ更新（keep のときは触らない）
      if (itOk) {
        (meta as any).itxReason = itReason;
        (meta as any).itx_reason = itReason;
      }
    }

    // iLexemeForce：sticky true（camel + snake）
    const iLexemeForceNext =
      (meta as any).iLexemeForce === true || (it as any).iLexemeForce === true;
    (meta as any).iLexemeForce = iLexemeForceNext;
    (meta as any).i_lexeme_force = iLexemeForceNext;

    // Tレーン：sticky禁止（毎ターン決定）
    // ✅ Tレイヤーは「今ターンの扉(itOk)」が開いたときだけ有効
    const tActive =
      carryOpenCommittedT3
        ? true
        : itOk && it.tLayerModeActive === true;
    const tHint =
      tActive
        ? (carryOpenCommittedT3 ? (it.tLayerHint ?? 'T3') : (it.tLayerHint ?? 'T2'))
        : null;
    const tVector = tActive ? (it.tVector ?? null) : null;

    // camel + snake
    (meta as any).tLayerModeActive = tActive;
    (meta as any).t_layer_mode_active = tActive;

    (meta as any).tLayerHint = tHint;
    (meta as any).t_layer_hint = tHint;

    (meta as any).tVector = tVector;
    (meta as any).t_vector = tVector;

    if (
      typeof process !== 'undefined' &&
      process.env.DEBUG_IROS_IT === '1' &&
      (!process.env.DEBUG_USER ||
        process.env.DEBUG_USER ===
          String((meta as any)?.userCode ?? (meta as any)?.user_code ?? ''))
    ) {

      console.log('[IROS/IT_TRIGGER]', {
        ok: itOk,

        // ✅ 再発防止：reason を必ず分離して表示（誤読不能化）
        itxWriteMode: (meta as any).itxWriteMode ?? (meta as any).itx_write_mode ?? null,
        itxPersistReason:
          (meta as any).itxPersistReason ??
          (meta as any).itx_persist_reason ??
          null,

        itxDecisionReason:
          (meta as any).itxDecisionReason ??
          (meta as any).itx_decision_reason ??
          itReason ??
          null,

        flags: it.flags,
        iLexemeForce: iLexemeForceNext,
        tLayerModeActive: tActive,
        tLayerHint: tHint,
        tVector,
        isCommittedT3,
        committedStep,
        carryOpenCommittedT3,

        // 既存互換：probe理由
        itx_probe_reason: (meta as any).itx_probe_reason ?? null,
      });
    }

  }

  // ----------------------------------------------------------------
  // I) Intent Transition v1.0（確定値として先に決める / meta反映）
  // ----------------------------------------------------------------
  {
    const r = applyIntentTransitionV1({
      text,
      meta,
      ms,
      lastDepthForContinuity: lastDepthForContinuity ?? null,
      lastSpinLoop: lastSpinLoop ?? null,
      goal: goal ?? null,
      priority: priority ?? null,
      normalizeDepthStrict,
    });

    meta = r.meta;
    goal = r.goal as any;
    priority = r.priority as any;
  }

  // ----------------------------------------------------------------
  // J) DescentGate + Frame + Slots（7.5）
  // ----------------------------------------------------------------
  {
    const rotationReason = String((meta as any)?.rotationState?.reason ?? '');
    const spinStepNow =
      typeof (meta as any).spinStep === 'number' ? (meta as any).spinStep : null;

    const r = applyContainerDecision({
      text,
      meta,
      prevDescentGate: lastDescentGate ?? null,
      rotationReason,
      spinStepNow,
      goalKind: (goal as any)?.kind ?? null,
    });

    meta = r.meta;

    // =========================================================
    // ✅ T3 Anchor Entry（証拠ベースでのみ開く）
    // - UI証拠（nextStepChoiceId 等）が無い場合は、限定条件つきで「テキスト証拠」を生成する
    //   - fixedNorth=SUN かつ itActive=true のときだけ
    //   - COMMIT系 → action
    //   - HOLD系（継続します等）→ intent_anchor が既にある場合だけ reconfirm
    // - DBカラム追加なし：itx_step / itx_anchor_event_type / intent_anchor に刻む
    // =========================================================
    {
      const norm = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim();

      const fixedNorthKey =
        typeof (meta as any)?.fixedNorth?.key === 'string'
          ? String((meta as any).fixedNorth.key)
          : typeof (meta as any)?.fixedNorth === 'string'
            ? String((meta as any).fixedNorth)
            : null;

      // ✅ “ITが生きているか” は「今回meta」優先 → 無ければ MemoryState を保険に
      const itReasonNow = String(
        (meta as any)?.itx_reason ?? (meta as any)?.itxReason ?? '',
      );
      const itReasonPrev = String(
        (ms as any)?.itx_reason ?? (ms as any)?.itxReason ?? '',
      );
      const itActive =
        itReasonNow.includes('IT_TRIGGER_OK') ||
        itReasonPrev.includes('IT_TRIGGER_OK');

      // ✅ intent_anchor の有無（MemoryStateを主として判定）
      const hasAnchorAlready = Boolean(
        normalizeIntentAnchor(
          (ms as any)?.intent_anchor ?? (ms as any)?.intentAnchor ?? null,
        ),
      );

      const COMMIT_RE =
        /(ここにコミット|コミットする|これでいく|これで行く|決めた|決めました|方針確定|仕様確定|採用する|採用します|固定する|固定します|北極星にする|SUNにする|.+?(を)?(やる|やります|進める|進めます|やってみる|着手する|着手します))/u;

      const HOLD_RE =
        /^(継続する|継続します|続ける|続けます|やる|やります|進める|進みます|守る|守ります)$/u;

      // 1) まずは既存の UI 証拠を拾う
      const uiEvidence = extractAnchorEvidence({
        meta,
        extra: meta && typeof meta === 'object' ? (meta as any).extra : null,
      });

      // evidence は「常にオブジェクト」にして downstream を安定させる
      let evidence: {
        choiceId?: string | null;
        actionId?: string | null;
        source?: string | null;
      } = uiEvidence && typeof uiEvidence === 'object' ? (uiEvidence as any) : {};

      // 2) UI証拠が無ければ「テキスト証拠」を生成（※SUN固定 + IT active のときだけ）
      const userT = norm(text);
      const noUiEvidence = !evidence?.choiceId && !evidence?.actionId;

      if (noUiEvidence && fixedNorthKey === 'SUN' && itActive) {
        // 強いコミット → action（T3コミット候補）
        if (COMMIT_RE.test(userT)) {
          evidence = {
            ...evidence,
            // detectAnchorEntry が choiceId 前提でも落ちないように “合成ID” を入れる
            choiceId: evidence?.choiceId ?? 'FN_SUN',
            actionId: 'action',
            source: 'text',
          };
        }
        // 短い継続宣言 → 既に anchor があるときだけ reconfirm（ダダ漏れ防止）
        else if (hasAnchorAlready && HOLD_RE.test(userT)) {
          evidence = {
            ...evidence,
            choiceId: evidence?.choiceId ?? 'FN_SUN',
            actionId: 'reconfirm',
            source: 'text',
          };
        }
      }

// --- DEBUG: detectAnchorEntry に渡す state の実体を確定する（暫定ログ） ---
const _ia_raw =
  (ms as any)?.intent_anchor ?? (ms as any)?.intentAnchor ?? null;

const _ia_obj =
  _ia_raw && typeof _ia_raw === 'object' ? (_ia_raw as any) : null;

const _ia_fixed = Boolean(_ia_obj && _ia_obj.fixed === true);

console.log('[IROS/ANCHOR_DEBUG][before-detect]', {
  ms_intent_anchor_raw: _ia_raw,
  ms_intent_anchor_fixed_true: _ia_fixed,
  itx_step_ms: (ms as any)?.itx_step ?? (ms as any)?.itxStep ?? null,
  evidence_choiceId: evidence?.choiceId ?? null,
  evidence_actionId: evidence?.actionId ?? null,
  evidence_source: evidence?.source ?? null,
});
// --- DEBUG end ---



      const anchorDecision = detectAnchorEntry({
        choiceId: evidence?.choiceId ?? null,
        actionId: evidence?.actionId ?? null,
        nowIso: new Date().toISOString(),
        state: {
          itx_step: (ms as any)?.itx_step ?? (ms as any)?.itxStep ?? null,
          itx_last_at:
            (ms as any)?.itx_last_at ?? (ms as any)?.itxLastAt ?? null,
          intent_anchor:
            (ms as any)?.intent_anchor ?? (ms as any)?.intentAnchor ?? null,
        },
      });

      const payload = {
        evidence,
        decision: {
          tEntryOk: anchorDecision.tEntryOk,
          anchorEvent: anchorDecision.anchorEvent,
          anchorWrite: anchorDecision.anchorWrite,
          reason: anchorDecision.reason,
        },
        fixedNorthKey,
        itActive,
        hasAnchorAlready,
      };

      console.log(
        `[IROS/ANCHOR_ENTRY] ${JSON.stringify(payload, (_k, v) =>
          v === undefined ? null : v,
        )}`,
      );

      // ✅ persist 側が拾える形で meta に刻む（DB列はここを参照する）
      (meta as any).anchorEntry = {
        evidence,
        decision: {
          tEntryOk: anchorDecision.tEntryOk,
          anchorEvent: anchorDecision.anchorEvent, // 'action' など
          anchorWrite: anchorDecision.anchorWrite, // 'commit' など
          reason: anchorDecision.reason,
        },
      };

      // ✅ 形ゆれ対策（pickAnchorEntry が拾えるようにフラットも入れる）
      (meta as any).anchor_event = anchorDecision.anchorEvent;
      (meta as any).anchor_write = anchorDecision.anchorWrite;
      (meta as any).anchorEvidenceSource = evidence?.source ?? null;

// patch は union 的に無い可能性があるので、存在ガードしてから使う
const patch =
  (anchorDecision as any)?.patch && typeof (anchorDecision as any).patch === 'object'
    ? ((anchorDecision as any).patch as {
        itx_step: 'T3';
        itx_anchor_event_type: string;
        intent_anchor: Record<string, any>;
      })
    : null;

// ✅ T3許可（tEntryOk）の刻印は commit を要求しない
// - commit は「fixed を立てる」ための別条件として温存
if (anchorDecision.tEntryOk && patch) {
  (meta as any).itx_step = patch.itx_step; // 'T3'
  (meta as any).itx_anchor_event_type = patch.itx_anchor_event_type; // choice/action/reconfirm

  // ✅ intent_anchor は正規化して載せる（camel + snake）
  // patch が空でも “既存 or fixedNorthKey” を必ず保持する
  const ia =
    normalizeIntentAnchor(
      patch.intent_anchor ??
        (meta as any).intent_anchor ??
        (meta as any).intentAnchor ??
        (fixedNorthKey ? { key: fixedNorthKey } : null),
    ) ?? null;

  (meta as any).intent_anchor = ia;
  (meta as any).intentAnchor = ia;
  (meta as any).intent_anchor_key =
    ia && typeof (ia as any).key === 'string' ? (ia as any).key : null;

  (meta as any).anchor_event_type = patch.itx_anchor_event_type;
  (meta as any).itx_last_at = new Date().toISOString();
}

    }
    // =========================================================
    // ✅ slotPlan 配線（flagReply → counsel → normalChat fallback）
    // - Record<string,true> に潰さない（render-v2 が本文を組めなくなる）
    // - meta.framePlan.slots は “slot objects 配列” を入れる
    // - slotPlanPolicy を meta / framePlan に必ず伝播
    // - fallback は「slots が空」or「policy が空」のときだけ
    // =========================================================

    const slotsRaw = (r as any).slotPlan?.slots ?? (r as any).slotPlan ?? null;

    // 1) まず slots は “配列だけ” を採用（それ以外は null）
    let slotsArr: any[] | null = Array.isArray(slotsRaw) ? slotsRaw : null;

    // 2) policy 候補
    const slotPlanPolicyRaw =
      (r as any).slotPlan?.slotPlanPolicy ??
      (r as any).slotPlanPolicy ??
      (r as any)?.framePlan?.slotPlanPolicy ??
      null;

    let slotPlanPolicy: string | null =
      typeof slotPlanPolicyRaw === 'string' && slotPlanPolicyRaw.trim()
        ? slotPlanPolicyRaw.trim()
        : null;

// 3) 無言アクト 判定（extra を単一ソース寄りに優先）
const ex =
  meta && typeof meta === 'object' && (meta as any).extra && typeof (meta as any).extra === 'object'
    ? (meta as any).extra
    : null;

const speechAct = String(ex?.speechAct ?? (meta as any)?.speechAct ?? '').toUpperCase();

const speechAllowLLM =
  typeof ex?.speechAllowLLM === 'boolean'
    ? ex.speechAllowLLM
    : typeof (meta as any)?.speechAllowLLM === 'boolean'
      ? (meta as any).speechAllowLLM
      : null;

const isSilence = speechAct === '無言アクト' || speechAllowLLM === false;

// ✅ framePlan 由来の slots/policy を fallback 判定の前に反映する
// - ただし frameSlots の “schema({id,required,hint})” は slotPlan ではないので流さない
{
  const looksRenderableSlotPlan = (arr: any[]): boolean => {
    for (const s of arr) {
      if (s == null) continue;
      if (typeof s === 'string' && s.trim()) return true;

      const hasText = typeof (s as any)?.text === 'string' && String((s as any).text).trim().length > 0;
      const hasContent =
        typeof (s as any)?.content === 'string' && String((s as any).content).trim().length > 0;
      const hasLines =
        Array.isArray((s as any)?.lines) &&
        (s as any).lines.some((l: any) => String(l ?? '').trim().length > 0);

      // schema({id,required,hint}) しか無いものは false に落ちる
      if (hasText || hasContent || hasLines) return true;
    }
    return false;
  };

  const fpSlots = (meta as any)?.framePlan?.slots;
  const fpPolicy = (meta as any)?.framePlan?.slotPlanPolicy;

  // slots: “render 可能っぽい” ときだけ seed する（schema は弾く）
  if (
    (!Array.isArray(slotsArr) || slotsArr.length === 0) &&
    Array.isArray(fpSlots) &&
    fpSlots.length > 0 &&
    looksRenderableSlotPlan(fpSlots)
  ) {
    slotsArr = fpSlots;
  }

  // policy: これは seed してOK（ただし空のときだけ）
  if (
    (!slotPlanPolicy || String(slotPlanPolicy).trim().length === 0) &&
    typeof fpPolicy === 'string' &&
    fpPolicy.trim()
  ) {
    slotPlanPolicy = fpPolicy.trim();
  }
}



    // 4) 空判定
    const hasText = String(text ?? '').trim().length > 0;

    const slotsEmpty0 = !Array.isArray(slotsArr) || slotsArr.length === 0;
    const policyEmpty0 =
      !slotPlanPolicy || String(slotPlanPolicy).trim().length === 0;

    // =========================================================
    // ✅ flagReply 条件（ここだけで “いつ立つか” を調整）
    // - fact/lookup は除外（答えが必要な質問は normalChat 側）
    // =========================================================
    function shouldUseFlagReply(metaLike: any, t0: string) {
      const t = String(t0 ?? '').trim();
      if (!t) return false;

      const inputKind = String(metaLike?.inputKind ?? '').toLowerCase();
      const factish =
        inputKind === 'fact' ||
        inputKind === 'lookup' ||
        inputKind === 'qa' ||
        inputKind === 'howto';


      const goalKind = String(
        metaLike?.goal?.kind ?? metaLike?.priority?.goal?.kind ?? '',
      ).toLowerCase();

      const consultish =
        goalKind === 'uncover' ||
        goalKind === 'stabilize' ||
        goalKind === 'repair' ||
        goalKind === 'counsel';

      // ✅ directTask は「完成物を作成して」系だけ true にする（誤爆防止）
      // - "要点/まとめ/仕様/設計" は構造化要求なので wantsStructure 側で拾う
      const directTaskTopic =
        /(文面|文章|返信文|メール|案内文|紹介文|テンプレ|下書き|ドラフト|添削|推敲)/.test(t);

      const directTaskVerb =
        /(作って|書いて|作成|用意|整えて|仕上げ|起こして|リライト|直して)/.test(t);

      const directTask = directTaskTopic && directTaskVerb;


      const wantsStructure =
        /(どれ|どっち|どう|どうしたら|どうすれば|何から|決められない|迷う|悩む|整理|要点|まとめ|結論|モヤ|引っかか|進まない|止まる)/.test(
          t,
        );

      // “短い内的相談” は flagReply の DYNAMICS/DEBLAME が効く
      const innerShort =
        t.length <= 40 &&
        /(しんど|つら|怖|不安|モヤ|やる気|止ま|進ま|わから)/.test(t);

      return consultish || directTask || wantsStructure || innerShort;
    }
// =========================================================
// ✅ counsel 明示トリガー（テスト用）
// - 先頭に /counsel を付けたら強制で counsel にする
// - ついでに /consult も許可（手癖用）
// - 本文は strip して meta に残すのは caller（ここ）側でやる
// =========================================================
function detectCounselCommand(raw: unknown): { forced: boolean; strippedText: string } {
  const t = String(raw ?? '').replace(/\r\n/g, '\n');

  // 先頭コマンドのみを対象（本文中の /counsel は誤爆させない）
  const m = t.match(/^\s*\/(counsel|consult)\b[ \t]*\n?([\s\S]*)$/i);
  if (!m) return { forced: false, strippedText: t.trim() };

  const rest = String(m[2] ?? '').trim();
  return { forced: true, strippedText: rest };
}

    // =========================================================
    // ✅ counsel 条件（モード or 構造）
    // =========================================================
    function shouldUseCounselByStructure(metaLike: any, t0: string) {
      const t = String(t0 ?? '').trim();
      if (!t) return false;

      const goalKind = String(
        metaLike?.goal?.kind ?? metaLike?.priority?.goal?.kind ?? '',
      ).toLowerCase();

      const inputKind = String(metaLike?.inputKind ?? '').toLowerCase();

      // ✅ レーン主導：uncover は「候補出し（IDEA_BAND）」で進めたいので counsel 条件から外す
      // ※counsel を立てるのは「落ち着かせる/修復する/相談進行」が必要なときだけ
      const consultish =
        goalKind === 'stabilize' ||
        goalKind === 'repair' ||
        goalKind === 'counsel';

      const factish =
        inputKind === 'fact' ||
        inputKind === 'lookup' ||
        inputKind === 'qa' ||
        inputKind === 'howto';

      // ✅ レーン主導：相談系のゴールで、かつ fact/howto/qa ではないときだけ counsel にする
      return consultish && !factish;
    }

// =========================================================
// ✅ Flow Observation（入口エンジン）
// - 意味を作らない
// - 解釈しない
// - 分岐に使わない
// - meta に「流れ」だけを示す
// =========================================================

{
  const historyArr = Array.isArray(history) ? (history as any[]) : [];

  // 直前の user 発話のみ取得（assistant は見ない）
  const lastUserText = (() => {
    for (let i = historyArr.length - 1; i >= 0; i--) {
      const m = historyArr[i];
      if (String(m?.role ?? '').toLowerCase() === 'user') {
        const v = m?.text ?? m?.content ?? null;
        return typeof v === 'string' ? v : null;
      }
    }
    return null;
  })();

  if (typeof text === 'string' && text.trim().length > 0) {
    const flow = observeFlow({
      currentText: text,
      lastUserText,
    });

    const deltaNow =
      typeof flow?.delta === 'string' && flow.delta.trim().length > 0
        ? flow.delta.trim()
        : null;

    const confidenceNow =
      typeof flow?.confidence === 'number' ? flow.confidence : null;

    // -------------------------------------------------------
    // 🔁 RETURN連続回数をここで確定（CTXPACK前の正本）
    // -------------------------------------------------------
    let prevReturnStreak = 0;

    for (let i = historyArr.length - 1; i >= 0; i--) {
      const m = historyArr[i];

      const rsRaw =
        (m as any)?.meta?.extra?.ctxPack?.flow?.returnStreak ??
        (m as any)?.meta?.ctxPack?.flow?.returnStreak ??
        (m as any)?.meta?.extra?.flow?.returnStreak ??
        (m as any)?.meta?.flow?.returnStreak ??
        null;

      if (typeof rsRaw === 'number' && Number.isFinite(rsRaw)) {
        prevReturnStreak = rsRaw;
        break;
      }

      if (
        typeof rsRaw === 'string' &&
        rsRaw.trim().length > 0 &&
        Number.isFinite(Number(rsRaw))
      ) {
        prevReturnStreak = Number(rsRaw);
        break;
      }
    }

    const returnStreakNow =
      deltaNow === 'RETURN' ? prevReturnStreak + 1 : 0;

    // -------------------------------------------------------
    // 👁 ViewShift: 前回スナップショット回収（判定は後段）
    // - まず baseMeta（=前回meta継承）から拾う
    // - 無ければ history から探す（互換保険）
    // -------------------------------------------------------
    let prevViewShiftSnap: any =
      (baseMeta as any)?.extra?.ctxPack?.viewShiftSnapshot ??
      (baseMeta as any)?.ctxPack?.viewShiftSnapshot ??
      (baseMeta as any)?.extra?.viewShiftSnapshot ??
      (baseMeta as any)?.viewShiftSnapshot ??
      null;

    if (!prevViewShiftSnap) {
      for (let i = historyArr.length - 1; i >= 0; i--) {
        const m = historyArr[i];

        const snap =
          (m as any)?.meta?.extra?.ctxPack?.viewShiftSnapshot ??
          (m as any)?.meta?.ctxPack?.viewShiftSnapshot ??
          (m as any)?.meta?.extra?.viewShiftSnapshot ??
          (m as any)?.meta?.viewShiftSnapshot ??
          null;

        if (snap && typeof snap === 'object') {
          prevViewShiftSnap = snap;
          break;
        }
      }
    }
    // -------------------------------------------------------
    // 🔑 正本として meta.extra.flow / viewShiftPrev に確定保存
    // -------------------------------------------------------
    (meta as any).extra =
      (meta as any).extra && typeof (meta as any).extra === 'object'
        ? (meta as any).extra
        : {};

    (meta as any).extra.flow = {
      delta: deltaNow,
      confidence: confidenceNow,
      returnStreak: returnStreakNow,
    };

    // ✅ ViewShift の前回スナップ（postprocess が拾う入口）
    // - prevViewShiftSnap が取れた時だけ上書きする
    // - null で既存（inject 済み）を潰さない
    const existingPrev =
      (meta as any)?.extra?.viewShiftPrev &&
      typeof (meta as any).extra.viewShiftPrev === 'object'
        ? (meta as any).extra.viewShiftPrev
        : null;

    if (prevViewShiftSnap && typeof prevViewShiftSnap === 'object') {
      (meta as any).extra.viewShiftPrev = prevViewShiftSnap;
    } else if (existingPrev) {
      // keep
      (meta as any).extra.viewShiftPrev = existingPrev;
    } else {
      // 明示的に null を書かない（未設定のまま）
      delete (meta as any).extra.viewShiftPrev;
    }

    // 既存互換（必要なら残す）
    (meta as any).flow = flow;

    // 観測ログ
    console.log('[IROS/FLOW][observe]', {
      delta: deltaNow,
      confidence: confidenceNow,
      hasLastUserText: Boolean(lastUserText),
      returnStreak: returnStreakNow,
    });

    console.log('[IROS/VIEWSHIFT][prevSnap]', {
      hasPrev: Boolean(prevViewShiftSnap),
      keptInjected: Boolean(!prevViewShiftSnap && existingPrev),
    });
  }

  // =========================================================
  // ✅ counsel 配線：normalChat fallback の前に差し込む
  // - mode名の揺れ：'counsel' / 'consult' を両方拾う
  // - stage はまず OPEN 固定（永続化は次工程）
  // - 相談モードでなくても、構造が counsel を要求するなら拾う
  // - ✅ テスト用：/counsel コマンドで強制（本文は strip 後を使う）
  // - ✅ 追加：GreetingGate 成立ターンは counsel に落とさない（新規チャット誤爆防止）
  // - ✅ レーン主導：counsel は「上書き」ではなく「空のときだけ埋める」
  // =========================================================

  // ※このファイルでは meta ではなく mergedBaseMeta を使う（meta が無いスコープ対策）
  const metaLike: any = (mergedBaseMeta ?? {}) as any;

  // ✅ mode を canonical に正規化（揺れ吸収はここだけ）
  const modeNorm = normalizeIrosMode(metaLike?.mode);
  const isCounselMode = modeNorm === 'counsel';

  // ✅ /counsel（/consult）明示トリガー
  const { forced: forcedCounsel, strippedText } = detectCounselCommand(text);

  // ✅ 明示トリガーがある場合は mode を canonical で確定（以降の判定がブレない）
  if (forcedCounsel) {
    metaLike.mode = 'counsel';
  }

  // ✅ 以降の判定・slot生成に使う「本文」（/counsel は混ぜない）
  const textForCounsel = forcedCounsel ? strippedText : text;
  const hasTextForCounsel = String(textForCounsel ?? '').trim().length > 0;

  // ✅ GreetingGate 成立ターン判定（ここで counsel 誤爆を遮断）
  const isGreetingTurn =
    !!metaLike?.gatedGreeting?.ok ||
    !!metaLike?.extra?.gatedGreeting?.ok ||
    String(metaLike?.ctxPack?.shortSummary ?? '') === 'greeting' ||
    String(metaLike?.extra?.ctxPack?.shortSummary ?? '') === 'greeting';

  // ✅ この下（QuestionSlots / normalChat fallback）が参照するので outer scope に示す
  let shouldUseCounsel = false;

  // ※重要：ir診断ターンは slotPlan を上書きしない（counsel/normalChat/flagReply を通さない）
  const isIrDiagnosisTurn_here =
    Boolean(metaLike?.isIrDiagnosisTurn) ||
    String(metaLike?.presentationKind ?? '').toLowerCase() === 'diagnosis' ||
    normalizeIrosMode(metaLike?.mode) === 'diagnosis';

if (!isIrDiagnosisTurn_here && !isGreetingTurn) {
  // ✅ stallHardNow（迷い/同語反復）は「counsel優先」のシグナルとして扱う
  // - stallProbe 側で meta.extra.stall.hardNow を残している前提
  const stallHardNow =
    !!(metaLike as any)?.extra?.stall?.hardNow ||
    !!(metaLike as any)?.stall?.hardNow ||
    false;

  // ✅ 構造として counsel が必要か
  // - 明示(/counsel, mode) は最優先
  // - stallHardNow は counsel 優先（IDEA_BANDへ倒さない）
  shouldUseCounsel =
    !!forcedCounsel ||
    isCounselMode ||
    stallHardNow ||
    shouldUseCounselByStructure(metaLike, textForCounsel);

  // ✅ レーン主導：counsel は「空のときだけ」差し込む
  // - 明示（/counsel or mode）だけは強制的に上書き可
  const canOverrideSlots = !!forcedCounsel || isCounselMode;
  const canFillWhenEmpty = slotsEmpty0 || policyEmpty0;

  if (
    !isSilence &&
    hasTextForCounsel &&
    shouldUseCounsel &&
    (canOverrideSlots || canFillWhenEmpty)
  ) {
    const lastSummary =
      (ms as any)?.situation_summary ??
      (ms as any)?.situationSummary ??
      (memoryState as any)?.situation_summary ??
      (memoryState as any)?.situationSummary ??
      metaLike?.situation_summary ??
      metaLike?.situationSummary ??
      null;

    console.log('[IROS/ORCH][counsel-picked]', {
      stage: 'OPEN',
      modeRaw: String(metaLike?.mode ?? '').toLowerCase(),
      forcedCounsel,
      shouldUseCounselByStructure: !forcedCounsel && !isCounselMode,
      hasText: hasTextForCounsel,
      isSilence,
      strippedLen: forcedCounsel ? String(strippedText ?? '').length : null,
      lastSummary_len: typeof lastSummary === 'string' ? lastSummary.length : null,
      isGreetingTurn,
      canOverrideSlots,
      canFillWhenEmpty,
      slotsEmpty0,
      policyEmpty0,
    });

    const counsel = buildCounselSlotPlan({
      userText: textForCounsel, // ✅ strip後
      stage: 'OPEN',
      lastSummary: typeof lastSummary === 'string' ? lastSummary : null,
    });

    const cSlots = (counsel as any).slots;
    const cPolicy = (counsel as any).slotPlanPolicy;

    // ✅ レーン主導：ここで「上書き」はしない（明示強制の場合のみ許可）
    slotsArr = Array.isArray(cSlots) ? cSlots : [];
    slotPlanPolicy =
      typeof cPolicy === 'string' && cPolicy.trim()
        ? cPolicy.trim()
        : 'FINAL';

    // 既存なら “上書き元” を残す
    (metaLike as any).slotPlanFallback =
      (metaLike as any).slotPlanFallback ?? 'counsel';

    console.log('[IROS/ORCH][counsel-picked]', {
      stage: 'OPEN',
      slotsLen: Array.isArray(slotsArr) ? slotsArr.length : null,
      policy: slotPlanPolicy,
    });
  }

  // 5) fallback（normalChat）
  // - slots が空 or policy が空 のときだけ
  // - counsel で埋まっていれば実行しない

  // ✅ seedFromFramePlan: framePlan が持つ slots/policy を slotPlan 側へ反映してから fallback 判定する
  {
    const fpSlots = (meta as any)?.framePlan?.slots;
    const fpPolicy = (meta as any)?.framePlan?.slotPlanPolicy;

    const fpSlotsOk = Array.isArray(fpSlots) && fpSlots.length > 0;
    const fpPolicyOk = typeof fpPolicy === 'string' && fpPolicy.trim().length > 0;

    // seed（空のときだけ埋める）
    if (fpSlotsOk && (!Array.isArray(slotsArr) || slotsArr.length === 0)) {
      slotsArr = fpSlots as any[];
    }
    if (fpPolicyOk && (!slotPlanPolicy || String(slotPlanPolicy).trim().length === 0)) {
      slotPlanPolicy = fpPolicy.trim();
    }

    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_FALLBACK_DIAG === '1') {
      console.log('[IROS/FallbackDiag][seedFromFramePlan]', {
        fpSlotsOk,
        fpSlotsLen: fpSlotsOk ? fpSlots.length : 0,
        fpPolicy: fpPolicyOk ? fpPolicy.trim() : null,
        slotsLen_afterSeed: Array.isArray(slotsArr) ? slotsArr.length : null,
        policy_afterSeed: slotPlanPolicy ? String(slotPlanPolicy) : null,
      });
    }
  }

  // ----------------------------------------------------------------
  // QuestionEngine（問い構造）
  // - IntentTransition の後 / slotPlan fallback 判定の前に実行する
  // - 初版は meta.extra.question に保存するだけ（slotPlan を直接変更しない）
  // ----------------------------------------------------------------
  {
    const ex =
      meta && typeof meta === 'object' && (meta as any).extra && typeof (meta as any).extra === 'object'
        ? (meta as any).extra
        : ((meta as any).extra = {});

    const eTurnNow =
      (meta as any)?.extra?.e_turn ??
      (meta as any)?.extra?.mirror?.e_turn ??
      (meta as any)?.e_turn ??
      null;

    const signalsNow =
      (meta as any)?.extra?.signals ??
      (meta as any)?.signals ??
      null;

    const intentLineNow =
      (meta as any)?.intentLine ??
      (meta as any)?.extra?.intentLine ??
      null;

    const intentTransitionNow =
      (meta as any)?.intentTransition ??
      (meta as any)?.extra?.intentTransition ??
      null;

    const lastSummaryForQuestion =
      (ms as any)?.situation_summary ??
      (ms as any)?.situationSummary ??
      (memoryState as any)?.situation_summary ??
      (memoryState as any)?.situationSummary ??
      (mergedBaseMeta as any)?.situation_summary ??
      (mergedBaseMeta as any)?.situationSummary ??
      null;

    ex.question =
      ex.question ??
      runQuestionEngine({
        userText: textForCounsel,
        qCode: (meta as any)?.qCode ?? null,
        eTurn: eTurnNow,
        signals: signalsNow,
        context: {
          conversationId: args.conversationId ?? null,
          topicHint: (signalsNow as any)?.topicHint ?? null,
          situationSummary: typeof lastSummaryForQuestion === 'string' ? lastSummaryForQuestion : null,
        },
        intentLine: intentLineNow,
        intentTransition: intentTransitionNow,
      });
  }

  const slotsEmpty =
    !Array.isArray(slotsArr) || (Array.isArray(slotsArr) && slotsArr.length === 0);
  const policyEmpty =
    !slotPlanPolicy || String(slotPlanPolicy).trim().length === 0;

  // ✅ QuestionSlots（HowTo/方法質問）は framePlan.slots が入っていても normalChat を優先して上書きする
  const forceQuestionSlots =
    !isSilence && hasTextForCounsel && !shouldUseCounsel && shouldUseQuestionSlots(textForCounsel);

  const shouldFallbackNormalChat =
    !isSilence &&
    hasTextForCounsel &&
    !shouldUseCounsel &&
    (forceQuestionSlots || slotsEmpty || policyEmpty);


// --- DEBUG: why normalChat fallback fired (no user text) ---
if (typeof process !== 'undefined' && process.env.DEBUG_IROS_FALLBACK_DIAG === '1') {
  console.log('[IROS/FallbackDiag][normalChat]', {
    isSilence,
    hasTextForCounsel,
    shouldUseCounsel,
    forceQuestionSlots,
    slotsEmpty,
    policyEmpty,
    slotsLen_before: Array.isArray(slotsArr) ? slotsArr.length : null,
    slotPlanPolicy_before: slotPlanPolicy ? String(slotPlanPolicy) : null,
    shouldFallbackNormalChat,
  });
}


if (shouldFallbackNormalChat) {
  const lastSummary =
    (ms as any)?.situation_summary ??
    (ms as any)?.situationSummary ??
    (memoryState as any)?.situation_summary ??
    (memoryState as any)?.situationSummary ??
    (mergedBaseMeta as any)?.situation_summary ??
    (mergedBaseMeta as any)?.situationSummary ??
    null;

  // ✅ IntentBridge laneKey を確定させてから normalChat fallback に渡す
  // - ここは「slotPlan を組む直前」なので downstream（normalChat）が確実に拾える
  // - userText はログに出さない（intentBridge 側が担保）
  // - fixedNorth と intent_anchor を混線させない：fixedNorth.key を優先
  {
    const ex =
      meta && typeof meta === 'object' && (meta as any).extra && typeof (meta as any).extra === 'object'
        ? (meta as any).extra
        : ((meta as any).extra = {});

    const depthStageNow =
      (meta as any)?.depthStage ?? (meta as any)?.depth ?? null;

    const phaseNow =
      (meta as any)?.phase ?? null;

    const fixedNorthKeyNow =
      typeof (meta as any)?.fixedNorth?.key === 'string'
        ? String((meta as any).fixedNorth.key)
        : typeof (meta as any)?.fixedNorth === 'string'
          ? String((meta as any).fixedNorth)
          : null;

    // deepenOk は取れれば渡す（取れない場合は undefined）
    const deepenOkNow =
      (meta as any)?.itTrigger?.flags?.deepenOk ??
      (meta as any)?.it?.flags?.deepenOk ??
      (meta as any)?.itx?.flags?.deepenOk ??
      (meta as any)?.deepenOk ??
      undefined;

    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_INTENTBRIDGE === '1') {
      console.log('[IROS/IntentBridge][RAW_INPUTS]', {
        itTrigger_flags: (meta as any)?.itTrigger?.flags ?? null,
        it_trigger_flags: (meta as any)?.it_trigger?.flags ?? null,
        meta_flags: (meta as any)?.flags ?? null,
        it_flags: (meta as any)?.it?.flags ?? null,
        itx_flags: (meta as any)?.itx?.flags ?? null,
        meta_deepenOk: (meta as any)?.deepenOk ?? null,
        depthStageNow,
        phaseNow,
        fixedNorthKeyNow,
        deepenOkNow,
      });
    }

    // lane判定入力（存在する値だけ拾う／無ければ false）
    // ✅ 優先順位：IT_TRIGGER(itTrigger) → it → itx → flags → その他
    // ※ flags が先だと「false が先に拾われ」IT_TRIGGER の true を潰す
    const hasCoreNow =
      (meta as any)?.itTrigger?.flags?.hasCore ??
      (meta as any)?.it?.flags?.hasCore ??
      (meta as any)?.itx?.flags?.hasCore ??
      (meta as any)?.flags?.hasCore ??
      (meta as any)?.core?.hasCore ??
      (meta as any)?.hasCore ??
      false;

    const laneKeyNowRaw =
      (meta as any)?.extra?.intentBridge?.laneKey ??
      (meta as any)?.intentBridge?.laneKey ??
      null;

    // ✅ テスト用：文頭に "tc:" があれば T_CONCRETIZE を強制（本番仕様には影響しない）
    const forceTConcretize =
      typeof text === 'string' && /^\s*tc\s*:/i.test(text);

    // ---- ✅ stall probe（メタ優先＋入力補助）
    // hard のときだけ T_CONCRETIZE を禁止して IDEA_BAND に倒す（会話の流れ復旧を優先）
    const stallMeta = (() => {
      // repeatSignal は rephrase 側（ctxPack）で先に見えていることがあるので、ここで拾ってメタに同期する
      const ctxPack =
        (meta as any)?.ctxPack ??
        (meta as any)?.extra?.ctxPack ??
        null;

      const rs =
        (meta as any)?.repeatSignal ??
        (meta as any)?.extra?.repeatSignal ??
        ctxPack?.repeatSignal ??
        null;

      // computeStallSignal は meta.ctxPack / meta.extra.ctxPack を見に行くので、両方に寄せる
      const ex2 =
        meta && typeof meta === 'object' && (meta as any).extra && typeof (meta as any).extra === 'object'
          ? (meta as any).extra
          : ((meta as any).extra = {});

      if (ctxPack && !(meta as any).ctxPack) (meta as any).ctxPack = ctxPack;
      if (ctxPack && !ex2.ctxPack) ex2.ctxPack = ctxPack;
      if (typeof rs === 'string' && rs.trim()) {
        if (!(meta as any).repeatSignal) (meta as any).repeatSignal = rs;
        if (!ex2.repeatSignal) ex2.repeatSignal = rs;
      }

      return meta;
    })();

    const stall = computeStallSignal({
      userText: String(textForCounsel ?? ''),
      history,
      meta: stallMeta,
    });

    const laneKeyNowBase = forceTConcretize ? 'T_CONCRETIZE' : laneKeyNowRaw;

    const focusLabelNow =
      (meta as any)?.extra?.intentBridge?.focusLabel ??
      (meta as any)?.intentBridge?.focusLabel ??
      undefined;

    const hasFocusLabelNow =
      typeof focusLabelNow === 'string' && focusLabelNow.trim().length > 0;

    // ✅ stall は lane を変えない（lane は IntentBridge の責務）
    // - 迷い/同語反復は「counsel 優先」のシグナルとして扱う（別の分岐で吸う）
    const stallHardNow = stall.severity === 'hard' && !hasFocusLabelNow;

    // ✅ postprocess(ExpressionLane) が参照する場所に同期しておく
    // - handleIrosReply.postprocess.ts は metaForSave.extra.stallHard を見ている
    // - ここで立てておけば「候補を出しますか？」等の preface 注入が動く
    try {
      const ex3 =
        meta && typeof meta === 'object' && (meta as any).extra && typeof (meta as any).extra === 'object'
          ? (meta as any).extra
          : ((meta as any).extra = {});
      ex3.stallHard = stallHardNow;

      // 既存の監査情報（stall）も残す
      ex3.stall = {
        ...(ex3.stall ?? {}),
        ...(stall ?? {}),
        hardNow: stallHardNow,
        at: Date.now(),
      };
    } catch {}

    const laneKeyNow = laneKeyNowBase;

    console.log('[IROS/T_CONCRETIZE][FORCE_SWITCH_CHECK]', {
      forceTConcretize,
      laneKeyNowRaw,
      laneKeyNowBase,
      laneKeyNow,
      stall,
      hasCoreNow,
      hasFocusLabelNow,
      focusLabelHead: hasFocusLabelNow ? String(focusLabelNow).slice(0, 40) : null,
      userHead: String(textForCounsel ?? '').slice(0, 40),
    });

    // ✅ intentBridge を single source of truth にする
    // - null のときは laneKey を渡さない（IDEA_BAND に落とさない）
    // - T/IDEA が明示されている時だけ渡す
    const resolvedLaneKeyForNormalChat =
      laneKeyNow === 'T_CONCRETIZE'
        ? 'T_CONCRETIZE'
        : laneKeyNow === 'IDEA_BAND'
          ? 'IDEA_BAND'
          : undefined;

    // ✅ normalChat に「直近ユーザー発話」を渡す（observeFlow の lastUserText を正しく効かせる）
    // - history は message 配列（role/text|content を持つ）なので、userだけ抽出して末尾だけ渡す
    const historyArrForNormalChat = Array.isArray(history) ? (history as any[]) : [];
    const recentUserTextsForNormalChat = historyArrForNormalChat
      .filter((m) => String(m?.role ?? '').toLowerCase() === 'user')
      .map((m) => {
        const v = m?.text ?? m?.content ?? null;
        return typeof v === 'string' ? v : '';
      })
      .map((s) => String(s).replace(/\r\n/g, '\n').trim())
      .filter(Boolean)
      .slice(-6);

    const currentUserTextForNormalChat = String(textForCounsel ?? '').trim();

    const earlyResolvedAskForNormalChat = (() => {
      const lc = currentUserTextForNormalChat.toLowerCase();

      const hasAnyInUser = (...needles: string[]) =>
        needles.some(
          (n) =>
            currentUserTextForNormalChat.includes(n) ||
            lc.includes(n.toLowerCase()),
        );

        const inheritedResolvedAskForNormalChat =
        (((meta as any)?.ctxPack?.resolvedAsk ??
          (meta as any)?.extra?.ctxPack?.resolvedAsk ??
          null) as any) || null;

      const recentJoinedForNormalChat = Array.isArray(recentUserTextsForNormalChat)
        ? recentUserTextsForNormalChat.join('\n')
        : '';

      const hasTruthLike =
        hasAnyInUser('真実', '事実', '本当') ||
        /真実|事実|本当/u.test(currentUserTextForNormalChat);

      const hasStructureLike =
        hasAnyInUser('構造的', '構造') ||
        /構造的|構造/u.test(currentUserTextForNormalChat);

      const hasHumanCreationLike =
        /地球外生命体.*人間.*(作った|創った|作られた|介入)/u.test(currentUserTextForNormalChat) ||
        /人間.*地球外生命体.*(作った|創った|作られた|介入)/u.test(currentUserTextForNormalChat) ||
        /宇宙人.*人間.*(作った|創った|作られた|介入)/u.test(currentUserTextForNormalChat) ||
        /人間.*宇宙人.*(作った|創った|作られた|介入)/u.test(currentUserTextForNormalChat);

      const hasHumanCreationLikeRecent =
        /地球外生命体.*人間.*(作った|創った|作られた|介入)/u.test(recentJoinedForNormalChat) ||
        /人間.*地球外生命体.*(作った|創った|作られた|介入)/u.test(recentJoinedForNormalChat) ||
        /宇宙人.*人間.*(作った|創った|作られた|介入)/u.test(recentJoinedForNormalChat) ||
        /人間.*宇宙人.*(作った|創った|作られた|介入)/u.test(recentJoinedForNormalChat);

      const isReferentialTruthFollowup =
        /その(並び|話|構造)/u.test(currentUserTextForNormalChat) ||
        /この(並び|話|構造)/u.test(currentUserTextForNormalChat) ||
        /あの(並び|話|構造)/u.test(currentUserTextForNormalChat) ||
        /(その|この|あの).*(地球外生命体|宇宙人).*(話|構造)/u.test(currentUserTextForNormalChat);

      if (
        inheritedResolvedAskForNormalChat?.askType === 'truth_structure' &&
        isReferentialTruthFollowup
      ) {
        return {
          topic: String(
            inheritedResolvedAskForNormalChat.topic ?? '地球外生命体が人間を作ったのか'
          ),
          askType: 'truth_structure',
          replyMode: String(
            inheritedResolvedAskForNormalChat.replyMode ?? 'direct_answer_first'
          ),
          sourceUserText: currentUserTextForNormalChat,
        };
      }

      if (
        isReferentialTruthFollowup &&
        hasHumanCreationLikeRecent &&
        (hasTruthLike || hasStructureLike || /並び/u.test(currentUserTextForNormalChat))
      ) {
        return {
          topic: '地球外生命体が人間を作ったのか',
          askType: 'truth_structure',
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserTextForNormalChat,
        };
      }

      if (hasHumanCreationLike && (hasTruthLike || hasStructureLike)) {
        return {
          topic: '地球外生命体が人間を作ったのか',
          askType: 'truth_structure',
          replyMode: 'direct_answer_first',
          sourceUserText: currentUserTextForNormalChat,
        };
      }

      return null;
    })();

    const earlyShiftKindForNormalChat =
      earlyResolvedAskForNormalChat?.askType === 'truth_structure'
        ? 'clarify_shift'
        : null;

        const existingCtxPackForNormalChat = (((meta as any)?.extra?.ctxPack ?? {}) as any);
        const questionForNormalChat =
          (existingCtxPackForNormalChat?.question &&
          typeof existingCtxPackForNormalChat.question === 'object')
            ? existingCtxPackForNormalChat.question
            : (((meta as any)?.extra?.question &&
                typeof (meta as any).extra.question === 'object')
                ? (meta as any).extra.question
                : null);

        const ctxPackForNormalChat = {
          ...existingCtxPackForNormalChat,
          ...(questionForNormalChat ? { question: questionForNormalChat } : {}),
          ...(earlyShiftKindForNormalChat ? { shiftKind: earlyShiftKindForNormalChat } : {}),
          ...(earlyResolvedAskForNormalChat ? { resolvedAsk: earlyResolvedAskForNormalChat } : {}),
        };

    const fallback = buildNormalChatSlotPlan({
      userText: textForCounsel,
      laneKey: resolvedLaneKeyForNormalChat,

      // ✅ 固定文言はやめて、選択された “一点” を渡す
      focusLabel: laneKeyNow === 'T_CONCRETIZE' ? focusLabelNow : undefined,

      // ✅ 上流で確定した判定を normalChat へ渡す
      ctxPack: ctxPackForNormalChat,
      meta,

      context: {
        lastSummary: typeof lastSummary === 'string' ? lastSummary : null,
        recentUserTexts: recentUserTextsForNormalChat,
      },
    });

    const fbSlots = (fallback as any).slots;
    slotsArr = Array.isArray(fbSlots) ? fbSlots : [];

    const fp = (fallback as any).slotPlanPolicy;
    slotPlanPolicy = typeof fp === 'string' && fp.trim() ? fp.trim() : 'FINAL';

    (meta as any).slotPlanFallback = 'normalChat';
  }

  // =========================================================
  // ✅ A) normalChat → flagReply 自動切替（仮置き一点の安全装置）
  // =========================================================
  {
    const reason = String(
      (meta as any)?.flow?.reason ?? (meta as any)?.convEvidence?.reason ?? '',
    );

    const hasNoAdvanceHint = /A!:no_advance_hint/.test(reason);
    const hasNoCtxSummary = /U!:no_ctx_summary/.test(reason);

    // 直前が normalChat 由来かどうか（＝通常入口で組めている）
    const cameFromNormalChat = (meta as any)?.slotPlanFallback === 'normalChat';

    // ✅ 切替条件（非常用）
    const shouldSwitchToFlagReply =
      cameFromNormalChat && (hasNoAdvanceHint || hasNoCtxSummary);

    // 直前 assistant 本文（one-shot 判定用）
    const historyArr = Array.isArray(history) ? (history as any[]) : [];
    let lastAssistantText = '';

    for (let i = historyArr.length - 1; i >= 0; i--) {
      const m = historyArr[i];
      if (String(m?.role ?? '').toLowerCase() !== 'assistant') continue;
      const v = m?.text ?? m?.content ?? '';
      if (typeof v === 'string' && v.trim()) {
        lastAssistantText = v;
        break;
      }
    }

    const prevUsedOnePoint =
      typeof lastAssistantText === 'string' && /いまの一点：/.test(lastAssistantText);

    if (
      !isSilence &&
      hasText &&
      !shouldUseCounsel &&
      shouldSwitchToFlagReply &&
      !prevUsedOnePoint
    ) {
      const flagSlots = buildFlagReplySlots({
        userText: text,
        hasHistory: true,
        questionAlreadyPlanned: false,

        // ✅ 直依頼（文面/手順/要点/まとめ/仕様/設計…）は directTask=true を渡す
        // NOTE: shouldUseFlagReply() と同じ判定語彙をここにも持つ（fallback経路でのズレ防止）
        directTask: /(文面|文章|手順|要点|まとめ|作って|書いて|整えて|テンプレ|仕様|設計)/.test(
          String(text ?? '').trim(),
        ),

        forceOnePoint: false,
      });

      slotsArr = Array.isArray(flagSlots) ? flagSlots : [];
      slotPlanPolicy = slotPlanPolicy || 'FINAL';
      (meta as any).slotPlanFallback = 'flagReply';

      console.log('[IROS/ORCH][flagReply-picked]', {
        cameFromNormalChat,
        hasNoCtxSummary,
        hasNoAdvanceHint,
        prevUsedOnePoint,
        reasonHead: reason.slice(0, 120),
      });
    }
  }
} else {
  // ✅ ir診断ターン：normalChat/flagReply/counsel で上書きしない
  // ただし upstream が slot を返さない場合があるので、最低限の seed slot をここで補完する
  const slotsEmpty_ir = !Array.isArray(slotsArr) || slotsArr.length === 0;
  const policyEmpty_ir = !slotPlanPolicy || String(slotPlanPolicy).trim().length === 0;

  if (slotsEmpty_ir) {
    const raw = String(text ?? '').trim();

    // "ir診断 自分" / "ir診断 ひろみの母" などからラベルを拾う（無ければ self）
    let label = 'self';
    if (raw.startsWith('ir診断')) {
      const rest = raw.slice('ir診断'.length).trim();
      if (rest) label = rest;
    }

    // ✅ irDiagnosis: diagnosisEngine に接続（src/lib/iros/diagnosis/* を通す）
    const diag = diagnosisEngine({
      targetLabel: label,
      meta: meta as any,
      slots: null,
      conversationId: null,
      userCode: (userCode as any) ?? null,
      traceId: null,
    });


  const seedText =
    diag.ok
      ? diag.text
      : [
          `ir診断 ${label}`,
          '',
          '観測対象：' + label,
          '出力：フェーズ／位相／深度（S/R/C/I/T）＋短い意識状態＋短いメッセージ',
          '',
          '入力：' + (raw || `(none)`),
          '',
          `※diagnosisEngine失敗: ${diag.reason}`,
        ].join('\n');

// ✅ 重要：API本文を空にしない（NormalBase fallback を回避）
// content は後段で const 定義されるため、ここでは代入しない。
// 代わりに meta.extra に “本文候補” を退避しておく（後段で拾う）。
{
  const ex =
    (meta as any).extra && typeof (meta as any).extra === 'object'
      ? (meta as any).extra
      : ((meta as any).extra = {});
  ex.contentOverride = seedText;
}

  slotsArr = [{ key: 'SEED_TEXT', text: seedText }];
  slotPlanPolicy = 'FINAL';

  console.log('[IROS/ORCH][irDiagnosis-diagnosisEngine]', {
    label,
    ok: diag.ok,
    head: diag.ok ? diag.head : null,
    slotsLen: Array.isArray(slotsArr) ? slotsArr.length : null,
    policy: slotPlanPolicy,
    rawLen: raw.length,
  });
}

  // ✅ ir診断ターン：fallback 表示は残さない
  if ((meta as any).slotPlanFallback) delete (meta as any).slotPlanFallback;
}

    // 6) 最終ガード：slots が配列でないなら null
    if (slotsArr != null && !Array.isArray(slotsArr)) {
      slotsArr = null;
    }

    // 7) ✅ 参照共有を切る（sameRef を false にする）
    if (Array.isArray(slotsArr)) {
      slotsArr = slotsArr.slice();
    }

    // 8) ✅ policy を最後に確定（slots があるなら null を残さない）
    if (!slotPlanPolicy && Array.isArray(slotsArr) && slotsArr.length > 0) {
      slotPlanPolicy = 'FINAL';
    }

    // 9) ✅ frame の正は framePlan.frame
    // - upstream(Context) が組んだ framePlan を最優先で守る（F→C上書き事故を止める）
    // - r 側は補助（meta に無い場合だけ採用）
    const frameFinal =
      (meta as any)?.framePlan?.frame ??
      (meta as any)?.frame ??
      (r as any)?.framePlan?.frame ??
      (r as any)?.frame ??
      null;


    // 10) ✅ framePlan は render-v2 が参照する唯一の正
    // - policy は FINAL/SCAFFOLD 以外を許さない
    // - slots があるなら policy は必ず FINAL を入れる（UNKNOWN/空は残さない）
    const normPolicy = (v: unknown): 'FINAL' | 'SCAFFOLD' | null => {
      if (typeof v !== 'string') return null;
      const s = v.trim().toUpperCase();
      if (s === 'FINAL') return 'FINAL';
      if (s === 'SCAFFOLD') return 'SCAFFOLD';
      return null;
    };

    const policyNorm0 = normPolicy(slotPlanPolicy);

    const slotsLen =
      Array.isArray(slotsArr) ? (slotsArr.length as number) : 0;

    const slotPlanPolicyFinal: 'FINAL' | 'SCAFFOLD' | null =
      policyNorm0 ?? (slotsLen > 0 ? 'FINAL' : null);

    // ✅ frame の単一ソース化：meta.frame は互換キーとして framePlan.frame と常に同値にする
    // - after-container で frame がズレると「C帯扱い」の誤誘導が起きるため、ここで必ず同期
    (meta as any).frame = frameFinal;

    (meta as any).frame = frameFinal;

    // ✅ debug / 互換キーも最終 frame に再同期
    // - container 側の仮判定(frameSelected)が残ると debug 上だけ C/R がズレて見える
    // - 正本は framePlan.frame / meta.frame なので、ここで最終値へ揃える
    (meta as any).frameSelected = frameFinal;

    if (
      (meta as any).frameDebug_containerDecision &&
      typeof (meta as any).frameDebug_containerDecision === 'object'
    ) {
      (meta as any).frameDebug_containerDecision = {
        ...(meta as any).frameDebug_containerDecision,
        frameSelected: frameFinal,
        meta_frame_after: frameFinal,
      };
    }

    // 12) ✅ ORCHログ用 “互換キー” を同期（必ず framePlan と同値）
    (meta as any).slotPlanPolicy = slotPlanPolicyFinal;

    // 13) 互換用 slotPlan は “必ず別参照” にする
    (meta as any).slotPlan =
      Array.isArray(slotsArr) ? slotsArr.slice() : slotsArr;

    // =========================================================
    // ✅ 観測ログ：slots がどこで崩れるかを “数値で” 固定
    // =========================================================
    const fpSlots = (meta as any).framePlan?.slots;
    const spSlots = (meta as any).slotPlan;



// ✅ slotPlanPolicy の正本を “framePlan 側” にも必ず同期（null残りを根絶）
if ((meta as any).framePlan && typeof (meta as any).framePlan === 'object') {
  (meta as any).framePlan.slotPlanPolicy = slotPlanPolicyFinal;
  // もし framePlan.slotPlan がある設計ならそこも同期（念のため）
  if ((meta as any).framePlan.slotPlan && typeof (meta as any).framePlan.slotPlan === 'object') {
    (meta as any).framePlan.slotPlan.slotPlanPolicy = slotPlanPolicyFinal;
  }
}


    // ✅ Phase11観測：key を “直取り” で確定（normalizeに依存しない）
    const iaKey =
      typeof (meta as any).intent_anchor_key === 'string' &&
      (meta as any).intent_anchor_key.trim()
        ? (meta as any).intent_anchor_key.trim()
        : typeof (meta as any).intentAnchorKey === 'string' &&
            (meta as any).intentAnchorKey.trim()
          ? (meta as any).intentAnchorKey.trim()
          : (meta as any).intent_anchor &&
              typeof (meta as any).intent_anchor === 'object' &&
              typeof (meta as any).intent_anchor.key === 'string' &&
              String((meta as any).intent_anchor.key).trim()
            ? String((meta as any).intent_anchor.key).trim()
            : (meta as any).intentAnchor &&
                typeof (meta as any).intentAnchor === 'object' &&
                typeof (meta as any).intentAnchor.key === 'string' &&
                String((meta as any).intentAnchor.key).trim()
              ? String((meta as any).intentAnchor.key).trim()
              : typeof (meta as any).intent_anchor === 'string' &&
                  (meta as any).intent_anchor.trim()
                ? (meta as any).intent_anchor.trim()
                : typeof (meta as any).intentAnchor === 'string' &&
                    (meta as any).intentAnchor.trim()
                  ? (meta as any).intentAnchor.trim()
                  : null;

    // ✅ この時点で intent_anchor_key が無いなら補完（final-sync待ちにしない）
    if (!(meta as any).intent_anchor_key && iaKey) {
      (meta as any).intent_anchor_key = iaKey;
    }

    console.log('[IROS/ORCH][after-container]', {
      frame: (meta as any).frame ?? null,
      framePlan_frame: (meta as any).framePlan?.frame ?? null,
      descentGate: (meta as any).descentGate ?? null,

      // framePlan 識別
      framePlan_kind: (meta as any).framePlan?.kind ?? null,
      framePlan_stamp: (meta as any).framePlan?.stamp ?? null,

      // ✅ IntentBridge 観測（extra / base を分離して最後に resolved）
      intentBridge_laneKey_extra: (meta as any)?.extra?.intentBridge?.laneKey ?? null,
      intentBridge_laneKey_base: (meta as any)?.intentBridge?.laneKey ?? null,
      intentBridge_laneKey_resolved:
        (meta as any)?.extra?.intentBridge?.laneKey ??
        (meta as any)?.intentBridge?.laneKey ??
        null,

      intentBridge_inputs_extra: {
        deepenOk: (meta as any)?.extra?.intentBridge?.deepenOk ?? null,
        hasCore: (meta as any)?.extra?.intentBridge?.hasCore ?? null,
        declarationOk: (meta as any)?.extra?.intentBridge?.declarationOk ?? null,
      },
      intentBridge_inputs_base: {
        deepenOk: (meta as any)?.intentBridge?.deepenOk ?? null,
        hasCore: (meta as any)?.intentBridge?.hasCore ?? null,
        declarationOk: (meta as any)?.intentBridge?.declarationOk ?? null,
      },

      // ✅ framePlan.slots の“生のキー”を強制観測（shape特定用）
      framePlan_slots_keys0: Array.isArray((meta as any).framePlan?.slots)
        ? Object.keys(((meta as any).framePlan.slots[0] ?? {}) as any)
        : null,

      framePlan_slots_raw0: Array.isArray((meta as any).framePlan?.slots)
        ? (meta as any).framePlan.slots[0]
        : null,


// ✅ slots 中身の先頭（どこで hint が混ざったか切り分け）
framePlan_slots_heads: Array.isArray((meta as any).framePlan?.slots)
  ? (meta as any).framePlan.slots.map((s: any) => ({
      key: s?.id ?? s?.key ?? null,
      head: String(s?.hint ?? s?.content ?? '')
        .replace(/\s+/g, ' ')
        .slice(0, 120),
    }))
  : null,


      slotPlan_slots_heads: Array.isArray((meta as any).slotPlan)
        ? (meta as any).slotPlan.map((s: any) => ({
            key: s?.key ?? null,
            head: String(s?.content ?? '')
              .replace(/\s+/g, ' ')
              .slice(0, 120),
          }))
        : null,


      framePlan_slots_isArray: Array.isArray(fpSlots),
      framePlan_slots_len: Array.isArray(fpSlots) ? fpSlots.length : null,

      slotPlan_isArray: Array.isArray(spSlots),
      slotPlan_len: Array.isArray(spSlots) ? spSlots.length : null,

      framePlan_policy: (meta as any).framePlan?.slotPlanPolicy ?? null,
      slotPlanPolicy: (meta as any).slotPlanPolicy ?? null,

      sameRef_framePlan_slotPlan: fpSlots === spSlots,
      slotPlanFallback: (meta as any).slotPlanFallback ?? null,
      // ✅ Phase11観測（確定版）
      hasIntentAnchor: Boolean(iaKey),
      intentAnchorKey: iaKey,

      // ✅ 参照元の存在だけ観測（中身は見ない）
      has_intent_anchor_obj: Boolean((meta as any).intent_anchor),
      has_intentAnchor_obj: Boolean((meta as any).intentAnchor),
      has_intent_anchor_key: Boolean((meta as any).intent_anchor_key),
      has_intentAnchorKey: Boolean((meta as any).intentAnchorKey),
    });

  }

  // ----------------------------------------------------------------
  // ✅ V2: 本文生成はしない（render-v2 が唯一の生成者）
  // ----------------------------------------------------------------
  const content = (() => {
    const ex: any = (meta as any)?.extra ?? null;
    const override =
      ex && typeof ex === 'object' && typeof ex.contentOverride === 'string'
        ? ex.contentOverride
        : '';

    return override.trim().length > 0 ? override : '';
  })();

  // ----------------------------------------------------------------
  // 10. meta の最終調整：Goal.targetDepth を depth に反映
  // ----------------------------------------------------------------
  const resolvedDepthRaw: Depth | null =
    (goal?.targetDepth as Depth | undefined) ??
    (meta.depth as Depth | undefined) ??
    ((meta as any).unified?.depth?.stage as Depth | null) ??
    null;

  const resolvedDepth: Depth | null = normalizeDepthStrictOrNull(resolvedDepthRaw);

  const fallbackDepth: Depth | undefined =
    normalizeDepthStrict(meta.depth as any) ?? undefined;

  let finalMeta: IrosMeta = {
    ...meta,
    depth: (resolvedDepth ?? fallbackDepth) ?? undefined,
  };
  // ✅ polarityBand を最終meta直下に昇格（MirrorFlow への橋渡し）
  // - 計算はしない（既にどこかで算出された値を拾うだけ）
  // - 優先順：meta直下 → meta.unified → finalMeta.unified
  (finalMeta as any).polarityBand =
    (meta as any)?.polarityBand ??
    (meta as any)?.unified?.polarityBand ??
    (finalMeta as any)?.unified?.polarityBand ??
    null;
  // 7.5で確定した “安全/器/枠” を finalMeta に確実に引き継ぐ
  (finalMeta as any).descentGate =
    (meta as any).descentGate ?? (finalMeta as any).descentGate ?? null;
  (finalMeta as any).descentGateReason =
    (meta as any).descentGateReason ??
    (finalMeta as any).descentGateReason ??
    null;

  (finalMeta as any).inputKind =
    (meta as any).inputKind ?? (finalMeta as any).inputKind ?? null;
  (finalMeta as any).frame =
    (meta as any).frame ?? (finalMeta as any).frame ?? null;
  (finalMeta as any).framePlan =
    (meta as any).framePlan ?? (finalMeta as any).framePlan ?? null;
  (finalMeta as any).slotPlan =
    (meta as any).slotPlan ?? (finalMeta as any).slotPlan ?? null;

  // ✅ Phase11：intent_anchor を最終metaにも必ず残す（camel + snake）
  // - 途中で meta.intent_anchor が落ちても、MemoryState(ms) を正として復元する
  {
    const ia =
    (finalMeta as any).intent_anchor ??
    (finalMeta as any).intentAnchor ??
    (ms as any)?.intent_anchor ??
    (ms as any)?.intentAnchor ??
    (memoryState as any)?.intent_anchor ??
    (memoryState as any)?.intentAnchor ??
    (mergedBaseMeta as any)?.intent_anchor ??
    null;

  (finalMeta as any).intent_anchor = ia;
  (finalMeta as any).intentAnchor = ia;

  (finalMeta as any).intent_anchor_key =
    ia && typeof ia.key === 'string' && ia.key.trim().length > 0 ? ia.key.trim() : null;
  }
  // unified.depth.stage / unified.q.current 同期（S4除去済みの finalMeta に合わせる）
  if ((finalMeta as any).unified) {
    const unifiedAny = (finalMeta as any).unified || {};
    const unifiedDepth = unifiedAny.depth || {};
    const unifiedQ = unifiedAny.q || {};

    const stage = (finalMeta as any).depth ?? null;
    const qCurrent = (finalMeta as any).qCode ?? null;
    const phase = (finalMeta as any).phase ?? null;

    (finalMeta as any).unified = {
      ...unifiedAny,
      depth: { ...unifiedDepth, stage },
      q: { ...unifiedQ, current: qCurrent },
      phase,

      selfAcceptance:
        typeof (finalMeta as any).selfAcceptance === 'number'
          ? (finalMeta as any).selfAcceptance
          : (unifiedAny as any).selfAcceptance ?? null,
      self_acceptance:
        typeof (finalMeta as any).selfAcceptance === 'number'
          ? (finalMeta as any).selfAcceptance
          : (unifiedAny as any).self_acceptance ?? null,

      yLevel:
        typeof (finalMeta as any).yLevel === 'number'
          ? (finalMeta as any).yLevel
          : (unifiedAny as any).yLevel ?? null,
      hLevel:
        typeof (finalMeta as any).hLevel === 'number'
          ? (finalMeta as any).hLevel
          : (unifiedAny as any).hLevel ?? null,
    };
  }

    // ----------------------------------------------------------------
    // IntentBridge（R→I explicit / I→T reconfirm）※補助のみ
    // - 既存のIT/transition/policy決定を置換しない
    // - meta.extra に「観測可能な補助フラグ」だけを載せる
    // ----------------------------------------------------------------

    const depthStageNow =
      (meta as any)?.depthStage ?? (meta as any)?.depth ?? (finalMeta as any)?.depth ?? null;

    const phaseNow =
      (meta as any)?.phase ?? (finalMeta as any)?.phase ?? null;

      const fixedNorthKeyNow =
      // ✅ fixedNorth と intent_anchor を混線させない：fixedNorth.key を優先
      (typeof (meta as any)?.fixedNorth?.key === 'string'
        ? String((meta as any).fixedNorth.key)
        : typeof (meta as any)?.fixedNorth === 'string'
          ? String((meta as any).fixedNorth)
          : null) ??
      (typeof (finalMeta as any)?.fixedNorth?.key === 'string'
        ? String((finalMeta as any).fixedNorth.key)
        : typeof (finalMeta as any)?.fixedNorth === 'string'
          ? String((finalMeta as any).fixedNorth)
          : null) ??
      FIXED_NORTH.key ??
      null;


// deepenOk は「取れれば渡す」。取れない場合は undefined（intentBridge 側で保守的に扱う）
const deepenOkNow =
  (meta as any)?.itTrigger?.flags?.deepenOk ??
  (meta as any)?.it?.flags?.deepenOk ??
  (meta as any)?.itx?.flags?.deepenOk ??
  (meta as any)?.deepenOk ??
  undefined;

// ✅ lane判定入力（存在する値だけ拾う／無ければ false）
const hasCoreNow =
(meta as any)?.itTrigger?.flags?.hasCore ??
(meta as any)?.it?.flags?.hasCore ??
(meta as any)?.itx?.flags?.hasCore ??
(meta as any)?.flags?.hasCore ??
(meta as any)?.core?.hasCore ??
(meta as any)?.hasCore ??
false;

const declarationOkNow =
(meta as any)?.itTrigger?.flags?.declarationOk ??
(meta as any)?.it?.flags?.declarationOk ??
(meta as any)?.itx?.flags?.declarationOk ??
(meta as any)?.flags?.declarationOk ??
(meta as any)?.declarationOk ??
false;

// --------------------------------------------------
// ✅ intentBridge 入力を meta.extra.intentBridge に集約
//    （laneKey を downstream に必ず流す）
// --------------------------------------------------
(meta as any).extra = (meta as any).extra || {};

const prevBridge = (meta as any).extra.intentBridge || {};

// ✅ intentBridge 入力を meta.extra.intentBridge に集約（laneKey/focusLabel は落とさない）
(meta as any).extra.intentBridge = {
  ...prevBridge,

  // intentBridge が見る入力
  deepenOk: deepenOkNow,
  hasCore: hasCoreNow,
  declarationOk: declarationOkNow,
};


// ❌ ここで applyIntentBridge を “もう一回” 呼ぶと、hasFocus=false 側のログが出て
//    laneKey が IDEA_BAND に戻るケースが発生する（今回の現象）
//
// ✅ すでに上（2105〜2113）で meta.extra.intentBridge に入力を集約済みで、
//    さらに earlier block（1596 側）で laneKey も付与されている前提なので、
//    ここでは “読むだけ” にする。
const bridge = (meta as any)?.extra?.intentBridge ?? null;

    // meta.extra / finalMeta.extra に載せる（上書きはしない）
    {
      const exMeta =
        typeof (meta as any).extra === 'object' && (meta as any).extra
          ? (meta as any).extra
          : ((meta as any).extra = {});
      const exFinal =
        typeof (finalMeta as any).extra === 'object' && (finalMeta as any).extra
          ? (finalMeta as any).extra
          : ((finalMeta as any).extra = {});

// IntentBridge（上書きしない）
// laneKey は downstream のために必ず流す（既存値があれば尊重）
if (bridge && typeof (bridge as any).laneKey === 'string') {
  // meta.extra 側：入力(deepenOk/hasCore/declarationOk) は既に入っている前提なので
  // laneKey だけを “足す”
  exMeta.intentBridge = {
    ...(exMeta.intentBridge ?? {}),
    laneKey: (exMeta.intentBridge as any)?.laneKey ?? (bridge as any).laneKey,
  };

  // finalMeta.extra 側：無ければ bridge を入れる / あれば laneKey だけ足す
  exFinal.intentBridge = exFinal.intentBridge ?? bridge;
  exFinal.intentBridge = {
    ...(exFinal.intentBridge ?? {}),
    laneKey: (exFinal.intentBridge as any)?.laneKey ?? (bridge as any).laneKey,
  };
}


    // ------------------------------------------------------------
    // PlaceholderGate（仮置き解除 + 方向候補）— 補助のみ / 上書きしない
    // ------------------------------------------------------------
    const placeholderGate = decidePlaceholderGate({
      depthStage: typeof depthStageNow === 'string' ? depthStageNow : null,

      // targetKind -> goalKindHint（nextStepOptions の語彙に寄せる）
      goalKindHint: (() => {
        const raw =
          (meta as any)?.targetKind ??
          (meta as any)?.target_kind ??
          null;

        const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
        if (s === 'uncover') return 'uncover';
        if (s === 'stabilize') return 'stabilize';
        // expand / pierce / その他は forward として扱う（保守）
        return 'forward';
      })(),

      // computeITTrigger.flags 互換（存在する方を拾う）
      itFlags:
        (meta as any)?.itTrigger?.flags ??
        (meta as any)?.it?.flags ??
        (meta as any)?.itx?.flags ??
        null,

      // intentBridge（bridge が空なら null）
      intentBridge:
        bridge && (bridge.intentEntered || bridge.itReconfirmed) ? bridge : null,
    });

    // meta.extra / finalMeta.extra に載せる（上書きしない / release時だけ）
    if (placeholderGate?.placeholderReleased) {
      const exMeta =
        typeof (meta as any).extra === 'object' && (meta as any).extra
          ? (meta as any).extra
          : ((meta as any).extra = {});
      exMeta.placeholderGate = exMeta.placeholderGate ?? placeholderGate;

      const exFinal =
        typeof (finalMeta as any).extra === 'object' && (finalMeta as any).extra
          ? (finalMeta as any).extra
          : ((finalMeta as any).extra = {});
      exFinal.placeholderGate = exFinal.placeholderGate ?? placeholderGate;
    }
    }

  // orchestrator.ts — [IROS/META][final-sync] 直前（単一ログ化）
  //
  // 目的：
  // - anchorEntry が meta / finalMeta まで届いているかを “ログで証明”
  // - final-sync では「生成/移送」はしない（存在確認だけ）
  // - ログは 1回ずつにして検証をブレさせない

  // 1) meta 側 anchorEntry（meta優先、なければ extra）
  const anchorEntryForMetaLog =
    (meta as any)?.anchorEntry ?? (meta as any)?.extra?.anchorEntry ?? null;

  // 2) meta の観測（ここで出れば「orchestrator内のmetaには来てる」）
  console.log('[IROS/META][final-sync][meta]', {
    meta_q: (meta as any)?.qCode ?? (meta as any)?.q ?? null,
    unified_q:
      (meta as any)?.unified?.q?.current ?? (meta as any)?.unified_q ?? null,
    meta_depth: (meta as any)?.depth ?? (meta as any)?.depthStage ?? null,
    unified_depth:
      (meta as any)?.unified?.depth?.stage ??
      (meta as any)?.unified_depth ??
      null,

    intent_anchor: (meta as any)?.intent_anchor ?? (meta as any)?.intentAnchor ?? null,
    intent_anchor_key:
      (meta as any)?.intent_anchor_key ?? (meta as any)?.intentAnchorKey ?? null,

    anchorEntry: anchorEntryForMetaLog,
  });

  // 3) finalMeta 側 anchorEntry（finalMeta優先、なければ extra）
  const anchorEntryForFinalLog =
    (finalMeta as any)?.anchorEntry ??
    (finalMeta as any)?.extra?.anchorEntry ??
    null;

  // 4) finalMeta の観測（ここで出れば「最終metaにも残っている」）
  console.log('[IROS/META][final-sync][finalMeta]', {
    meta_q: (finalMeta as any)?.qCode ?? null,
    unified_q: (finalMeta as any)?.unified?.q?.current ?? null,
    meta_depth: (finalMeta as any)?.depth ?? null,
    unified_depth: (finalMeta as any)?.unified?.depth?.stage ?? null,

    intent_anchor:
      (finalMeta as any)?.intent_anchor ?? (finalMeta as any)?.intentAnchor ?? null,
    intent_anchor_key:
      (finalMeta as any)?.intent_anchor_key ?? (finalMeta as any)?.intentAnchorKey ?? null,

    anchorEntry: anchorEntryForFinalLog,
  });

  // ----------------------------------------------------------------
  // ✅ V2: “モデル生出力” はここでは絶対に作らない（追跡のため空を固定）
  // ----------------------------------------------------------------
  {
    const ex =
      typeof (finalMeta as any).extra === 'object' && (finalMeta as any).extra
        ? (finalMeta as any).extra
        : ((finalMeta as any).extra = {});

    /* rawTextFromModel: do not blank here */
    ex.persistedBy = ex.persistedBy ?? 'route'; // 任意：single-writer の目印
  }

  // ----------------------------------------------------------------
  // 11. MemoryState 保存（finalMeta ベース）
  // ----------------------------------------------------------------
  (finalMeta as any).situationSummary =
    typeof text === 'string' && text.trim().length > 0 ? text.trim() : null;

// ----------------------------------------------------------------
// 11.5 Person Intent Memory 保存（ir診断ターンのみ）
// ----------------------------------------------------------------
if (userCode && finalMeta) {
  const anyMeta = finalMeta as any;
  const trimmed = (text || '').trim();

  // ir診断モードをトリガーしないように、'ir診断'のテキストが含まれていても診断モードに入らないように
  const isIrDiagnosisTurn =
    !!anyMeta.isIrDiagnosisTurn &&
    !/^(iros|Iros|IROS)/i.test(trimmed) &&  // "Iros" や "iros" を除外
    !trimmed.startsWith('ir診断'); // 'ir診断' で始まるテキストを除外

  if (isIrDiagnosisTurn) {
    let label = 'self';

    // 'ir診断'のテキストに基づいて処理を変更
    const rest = trimmed.slice('ir診断'.length).trim();
    if (rest.length > 0) label = rest;


    // ✅ core_need を meta から拾う（intentLine 優先 → soulNote → unified.soulNote）
    const il = (anyMeta.intentLine ?? anyMeta.intent_line ?? null) as any;
    const sn = (anyMeta.soulNote ?? anyMeta.soul_note ?? anyMeta.unified?.soulNote ?? anyMeta.unified?.soul_note ?? null) as any;

    const coreNeedRaw =
      (typeof il?.coreNeed === 'string' ? il.coreNeed : null) ??
      (typeof il?.core_need === 'string' ? il.core_need : null) ??
      (typeof sn?.core_need === 'string' ? sn.core_need : null) ??
      (typeof sn?.coreNeed === 'string' ? sn.coreNeed : null) ??
      null;

    const coreNeed =
      typeof coreNeedRaw === 'string' && coreNeedRaw.trim().length > 0
        ? coreNeedRaw.trim()
        : null;

    try {
      await savePersonIntentState({
        ownerUserCode: userCode,
        targetType: 'ir-diagnosis',
        targetLabel: label,
        qPrimary: finalMeta.qCode ?? null,
        depthStage: (finalMeta as any).depth ?? null,
        phase: (finalMeta as any).phase ?? null,
        tLayerHint: (finalMeta as any).tLayerHint ?? null,
        selfAcceptance:
          typeof finalMeta.selfAcceptance === 'number' ? finalMeta.selfAcceptance : null,

        // ✅ 追加：core_need を保存
        coreNeed,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[IROS/Orchestrator] savePersonIntentState error', e);
    }
  }
}
  }
// ----------------------------------------------------------------
// 12. Orchestrator 結果として返却（V2：contentは空）
// ----------------------------------------------------------------
return {
  content: '',
  meta,
};
}
}
