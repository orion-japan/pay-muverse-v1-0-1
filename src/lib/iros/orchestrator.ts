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
} from './system';

import { clampSelfAcceptance } from './orchestratorMeaning';
import { computeSpinState } from './orchestratorSpin';
import { buildNormalChatSlotPlan } from './slotPlans/normalChat';

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
import { applyContainerDecision } from './orchestratorContainer';
import { applySoul } from './orchestratorSoul';

// IT Trigger
import { computeITTrigger } from '@/lib/iros/rotation/computeITTrigger';
import { detectIMode } from './iMode';
import { extractAnchorEvidence } from '@/lib/iros/anchor/extractAnchorEvidence';
import { detectAnchorEntry } from '@/lib/iros/anchor/AnchorEntryDetector';

// Person Intent Memory（ir診断）
import { savePersonIntentState } from './memory/savePersonIntent';

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
    (meta as any)?.intent_anchor ??
    (meta as any)?.intentAnchor ??
    null;

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
    spinLoop: (typeof lastSpinLoop !== 'undefined' ? lastSpinLoop : null) ?? null,
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
  const stepNow =
    (meta as any)?.itx_step ??
    (meta as any)?.itxStep ??
    null;

  const reasonNow =
    (meta as any)?.itx_reason ??
    (meta as any)?.itxReason ??
    null;

  const lastAtNow =
    (meta as any)?.itx_last_at ??
    (meta as any)?.itxLastAt ??
    null;

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

  // ✅ prevIt_fromMeta.active の材料：IT_TRIGGER_OK が見えていれば active 扱い
  const active =
    typeof reasonFinal === 'string' && reasonFinal.includes('IT_TRIGGER_OK');

  (meta as any).it_triggered = active;
  (meta as any).itTriggered = active;
}

  // ----------------------------------------------------------------
  // 7.75 IT Trigger（I→T の扉） + I語彙の表出許可
  // ----------------------------------------------------------------
  {
    const historyArr = Array.isArray(history) ? (history as any[]) : [];

    const userHistory = historyArr.filter((m) => {
      const role = String(m?.role ?? '').toLowerCase();
      return role === 'user';
    });

    const last3User = userHistory.slice(-3).map((m: any) => {
      const v = m?.text ?? m?.content ?? null;
      return typeof v === 'string' ? v : null;
    });

    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
      console.log('[IROS/IT][probe] before', {
        textHead: (text || '').slice(0, 80),
        historyLen: historyArr.length,
        historyUserLen: userHistory.length,
        last3User,
        depth: meta.depth ?? null,
        intentLine: (meta as any).intentLine ?? null,
        fixedNorth: (meta as any).fixedNorth ?? null,
        intent_anchor: (meta as any).intent_anchor ?? null,
      });
    }

    // =========================================================
    // ✅ computeITTrigger 呼び出し（既存の const it は 1個だけ）
    // - meta は「縮めない」：fixedNorth / intentLine / intent_anchor をそのまま渡す
    // - prevIt は MemoryState が主ソースなので “metaへ詰め直し” はしない
    // - computeITTrigger 側で camel/snake を吸う（入力側で二重定義しない）
    // =========================================================
    const it = computeITTrigger({
      text,
      history: historyArr, // ✅ full（assistant含む）
      meta, // ✅ そのまま渡す（縮めない）
      memoryState: (memoryState ?? null) as any, // ✅ 主ソース
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
    const itOk = it.ok === true;
    const itReason = it.reason ?? null;

    // ok/reason：camel + snake
    (meta as any).itTriggered = itOk;
    (meta as any).it_triggered = itOk;

    (meta as any).itxReason = itReason;
    (meta as any).itx_reason = itReason;

    // iLexemeForce：sticky true（camel + snake）
    const iLexemeForceNext =
      (meta as any).iLexemeForce === true || (it as any).iLexemeForce === true;
    (meta as any).iLexemeForce = iLexemeForceNext;
    (meta as any).i_lexeme_force = iLexemeForceNext;

    // Tレーン：sticky禁止（毎ターン決定）
    const tActive = itOk && it.tLayerModeActive === true;
    const tHint = tActive ? (it.tLayerHint ?? 'T2') : null;
    const tVector = tActive ? (it.tVector ?? null) : null;

    // camel + snake
    (meta as any).tLayerModeActive = tActive;
    (meta as any).t_layer_mode_active = tActive;

    (meta as any).tLayerHint = tHint;
    (meta as any).t_layer_hint = tHint;

    (meta as any).tVector = tVector;
    (meta as any).t_vector = tVector;

    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
      console.log('[IROS/IT_TRIGGER]', {
        ok: itOk,
        reason: itReason,
        flags: it.flags,
        iLexemeForce: iLexemeForceNext,
        tLayerModeActive: tActive,
        tLayerHint: tHint,
        tVector,
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
        /(ここにコミット|コミットする|これでいく|これで行く|決めた|決めました|固定する|固定します|北極星にする|SUNにする)/;

      const HOLD_RE =
        /^(継続する|継続します|続ける|続けます|やる|やります|進める|進みます|守る|守ります)$/u;

      // 1) まずは既存の UI 証拠を拾う
      let evidence = extractAnchorEvidence({
        meta,
        extra: meta && typeof meta === 'object' ? (meta as any).extra : null,
      });

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
          } as any;
        }
        // 短い継続宣言 → 既に anchor があるときだけ reconfirm（ダダ漏れ防止）
        else if (hasAnchorAlready && HOLD_RE.test(userT)) {
          evidence = {
            ...evidence,
            choiceId: evidence?.choiceId ?? 'FN_SUN',
            actionId: 'reconfirm',
            source: 'text',
          } as any;
        }
      }

      const anchorDecision = detectAnchorEntry({
        choiceId: evidence.choiceId,
        actionId: evidence.actionId,
        nowIso: new Date().toISOString(),
        state: {
          itx_step: (ms as any)?.itx_step ?? (ms as any)?.itxStep ?? null,
          itx_last_at: (ms as any)?.itx_last_at ?? (ms as any)?.itxLastAt ?? null,
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
      (meta as any).anchorEvidenceSource = evidence.source;

      if (anchorDecision.tEntryOk && anchorDecision.anchorWrite === 'commit') {
        const p = anchorDecision.patch;

        (meta as any).itx_step = p.itx_step; // 'T3'
        (meta as any).itx_anchor_event_type = p.itx_anchor_event_type; // choice/action/reconfirm

// ✅ intent_anchor は正規化して載せる（camel + snake）
// patch が空でも “既存 or fixedNorthKey” を必ず保持する
const ia =
  normalizeIntentAnchor(
    p.intent_anchor ??
      (meta as any).intent_anchor ??
      (meta as any).intentAnchor ??
      (fixedNorthKey ? { key: fixedNorthKey } : null),
  ) ?? null;

(meta as any).intent_anchor = ia;
(meta as any).intentAnchor = ia;
(meta as any).intent_anchor_key =
  ia && typeof (ia as any).key === 'string' ? (ia as any).key : null;


        (meta as any).anchor_event_type = p.itx_anchor_event_type;
        (meta as any).itx_last_at = new Date().toISOString();
      }
    }

    // =========================================================
    // ✅ 非SILENCEの空slotPlan救済：normalChat を必ず差し込む（配列を保持）
    // - Record<string,true> に潰さない（render-v2 が本文を組めなくなる）
    // - meta.framePlan.slots は “slot objects 配列” を入れる
    // - slotPlanPolicy を meta / framePlan に必ず伝播
    // - fallback は「slots が空」or「policy が空」のときだけ（必須）
    // - ORCHログ用に meta.slotPlanPolicy を同期（null撲滅）
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

    // 3) SILENCE 判定
    const speechAct = String((meta as any)?.speechAct ?? '').toUpperCase();
    const speechAllowLLM = (meta as any)?.speechAllowLLM;
    const isSilence = speechAct === 'SILENCE' || speechAllowLLM === false;

    // 4) ✅ fallback 発火条件を絞る（slots 空 OR policy 空 のときだけ）
    const hasText = String(text ?? '').trim().length > 0;

    const slotsEmpty = !Array.isArray(slotsArr) || slotsArr.length === 0;
    const policyEmpty =
      !slotPlanPolicy || String(slotPlanPolicy).trim().length === 0;

    const shouldFallbackNormalChat =
      !isSilence && hasText && (slotsEmpty || policyEmpty);

    // 5) fallback（normalChat）
    if (shouldFallbackNormalChat) {
      const fallback = buildNormalChatSlotPlan({ userText: text });

      const fbSlots = (fallback as any).slots;
      slotsArr = Array.isArray(fbSlots) ? fbSlots : [];

      const fp = (fallback as any).slotPlanPolicy;
      slotPlanPolicy = typeof fp === 'string' && fp.trim() ? fp.trim() : 'FINAL';

      (meta as any).slotPlanFallback = 'normalChat';
    } else {
      // ✅ fallback しなかった場合は “残骸” を消す（誤誘導防止）
      if ((meta as any).slotPlanFallback === 'normalChat') {
        delete (meta as any).slotPlanFallback;
      }
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
    const frameFinal =
      (r as any)?.framePlan?.frame ??
      (r as any)?.frame ??
      (meta as any)?.framePlan?.frame ??
      (meta as any)?.frame ??
      null;

    // 10) ✅ framePlan は render-v2 が参照する唯一の正（重複代入しない）
    (meta as any).framePlan = {
      frame: frameFinal,
      slots: slotsArr, // ✅ render-v2 側はこれ（slot objects 配列）
      slotPlanPolicy,
    };

    // 11) ✅ ORCHログ用 “互換キー” を同期（slotPlanPolicy:null を消す）
    (meta as any).slotPlanPolicy = slotPlanPolicy;

    // 12) 互換用 slotPlan は “必ず別参照” にする（sameRef事故を潰す）
    (meta as any).slotPlan = Array.isArray(slotsArr)
      ? slotsArr.slice()
      : slotsArr;

    // 13) T系の戻り値は meta に反映（あれば）
    if (typeof (r as any).tLayerModeActive === 'boolean') {
      (meta as any).tLayerModeActive = (r as any).tLayerModeActive;
    }
    if (
      typeof (r as any).tLayerHint === 'string' &&
      (r as any).tLayerHint.trim()
    ) {
      (meta as any).tLayerHint = (r as any).tLayerHint.trim();
    }

// =========================================================
// ✅ 観測ログ：slots がどこで崩れるかを “数値で” 固定
// =========================================================
const fpSlots = (meta as any).framePlan?.slots;
const spSlots = (meta as any).slotPlan;

// ✅ Phase11観測：key を “直取り” で確定（normalizeに依存しない）
const iaKey =
  // 1) すでに key が別キーで入ってるなら最優先で採用
  (typeof (meta as any).intent_anchor_key === 'string' && (meta as any).intent_anchor_key.trim())
    ? (meta as any).intent_anchor_key.trim()
    : (typeof (meta as any).intentAnchorKey === 'string' && (meta as any).intentAnchorKey.trim())
      ? (meta as any).intentAnchorKey.trim()
      : // 2) intent_anchor / intentAnchor が object なら key を拾う
      (meta as any).intent_anchor && typeof (meta as any).intent_anchor === 'object' &&
        typeof (meta as any).intent_anchor.key === 'string' && String((meta as any).intent_anchor.key).trim()
        ? String((meta as any).intent_anchor.key).trim()
        : (meta as any).intentAnchor && typeof (meta as any).intentAnchor === 'object' &&
            typeof (meta as any).intentAnchor.key === 'string' && String((meta as any).intentAnchor.key).trim()
          ? String((meta as any).intentAnchor.key).trim()
          : // 3) まれに string 直入れケース
          (typeof (meta as any).intent_anchor === 'string' && (meta as any).intent_anchor.trim())
            ? (meta as any).intent_anchor.trim()
            : (typeof (meta as any).intentAnchor === 'string' && (meta as any).intentAnchor.trim())
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
  const content = '';

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
  const iaRaw =
    (finalMeta as any).intent_anchor ??
    (finalMeta as any).intentAnchor ??
    (ms as any)?.intent_anchor ??
    (ms as any)?.intentAnchor ??
    (memoryState as any)?.intent_anchor ??
    (mergedBaseMeta as any)?.intent_anchor ??
    null;

  const ia = normalizeIntentAnchor(iaRaw);

  (finalMeta as any).intent_anchor = ia;
  (finalMeta as any).intentAnchor = ia;

  (finalMeta as any).intent_anchor_key =
    ia && typeof ia.key === 'string' && ia.key.trim().length > 0
      ? ia.key.trim()
      : null;
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

  console.log('[IROS/META][final-sync]', {
    meta_q: (finalMeta as any).qCode ?? null,
    unified_q: (finalMeta as any).unified?.q?.current ?? null,
    meta_depth: (finalMeta as any).depth ?? null,
    unified_depth: (finalMeta as any).unified?.depth?.stage ?? null,

    // ✅ Phase11観測
    intent_anchor: (finalMeta as any).intent_anchor ?? null,
    intent_anchor_key: (finalMeta as any).intent_anchor_key ?? null,
  });

  // ----------------------------------------------------------------
  // 10.2 Spin の最終確定（finalMeta.depth 決定後に再計算）
  // ----------------------------------------------------------------
  {
    const spin = computeSpinState({
      depthStage: (finalMeta as any).depth ?? null,
      qCode: (finalMeta as any).qCode ?? null,
      phase: (finalMeta as any).phase ?? null,
      lastSpinLoop,
      lastSpinStep,
      lastPhase: lastPhaseForSpin,
    });

    (finalMeta as any).spinLoop = spin.spinLoop;
    (finalMeta as any).spinStep = spin.spinStep;
  }

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
    const isIrDiagnosisTurn = !!anyMeta.isIrDiagnosisTurn;

    if (isIrDiagnosisTurn) {
      let label = 'self';
      const trimmed = (text || '').trim();

      if (trimmed.startsWith('ir診断')) {
        const rest = trimmed.slice('ir診断'.length).trim();
        if (rest.length > 0) label = rest;
      }

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
            typeof finalMeta.selfAcceptance === 'number'
              ? finalMeta.selfAcceptance
              : null,
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[IROS/Orchestrator] savePersonIntentState error', e);
      }
    }
  }

  // ----------------------------------------------------------------
  // 12. Orchestrator 結果として返却（V2：contentは空）
  // ----------------------------------------------------------------
  return {
    content,
    meta: finalMeta,
  };
}
