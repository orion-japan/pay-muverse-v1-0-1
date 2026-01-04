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
  // - intent_anchor は「可変アンカー（Tで刺さる意図）」専用に空ける
  // =========================================================
  {
    (meta as any).fixedNorth = FIXED_NORTH;
    // intent_anchor は触らない（上書き禁止）
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

  // ----------------------------------------------------------------
  // 7.75 IT Trigger（I→T の扉） + I語彙の表出許可
  // ----------------------------------------------------------------
  {
    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
      console.log('[IROS/IT][probe] before', {
        textHead: (text || '').slice(0, 80),
        historyLen: Array.isArray(history) ? history.length : null,
        last3: Array.isArray(history)
          ? history.slice(-3).map((m: any) => m?.content ?? m?.text ?? null)
          : null,
        depth: meta.depth ?? null,
        intentLine: (meta as any).intentLine ?? null,
      });
    }

    const it = computeITTrigger({
      text,
      history: Array.isArray(history) ? history : [],
      meta: {
        depthStage: meta.depth ?? null,
        intentLine: (meta as any).intentLine ?? null,
      },
    });

    console.log('[IROS/IT][result]', {
      ok: it.ok,
      reason: it.reason,
      flags: it.flags,
      tLayerModeActive: it.tLayerModeActive,
      tLayerHint: it.tLayerHint,
      tVector: it.tVector,
    });

    // iLexemeForce は sticky true のみ
    (meta as any).iLexemeForce =
      (meta as any).iLexemeForce === true || it.iLayerForce === true;

    // Tレーンは sticky禁止：毎ターン決定
    (meta as any).tLayerModeActive = it.ok && it.tLayerModeActive === true;
    (meta as any).tLayerHint =
      (meta as any).tLayerModeActive ? (it.tLayerHint ?? 'T2') : null;
    (meta as any).tVector =
      (meta as any).tLayerModeActive ? (it.tVector ?? null) : null;

    if (typeof process !== 'undefined' && process.env.DEBUG_IROS_IT === '1') {
      // eslint-disable-next-line no-console
      console.log('[IROS/IT_TRIGGER]', {
        ok: it.ok,
        reason: it.reason,
        flags: it.flags,
        iLexemeForce: (meta as any).iLexemeForce ?? null,
        tLayerModeActive: (meta as any).tLayerModeActive ?? null,
        tLayerHint: (meta as any).tLayerHint ?? null,
        tVector: (meta as any).tVector ?? null,
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

    // ★ slotPlan を record に正規化（WriterHints / SAFE がキーを拾える形）
    function toSlotRecord(v: any): Record<string, true> | null {
      if (!v) return null;

      if (Array.isArray(v)) {
        const rec: Record<string, true> = {};
        for (const k of v) {
          if (typeof k === 'string' && k.trim()) rec[k.trim()] = true;
        }
        return Object.keys(rec).length ? rec : null;
      }

      if (typeof v === 'object') {
        const rec: Record<string, true> = {};
        for (const [k, val] of Object.entries(v)) {
          if (typeof k === 'string' && k.trim() && val) rec[k.trim()] = true;
        }
        return Object.keys(rec).length ? rec : null;
      }

      return null;
    }

// =========================================================
// ✅ 非SILENCEの空slotPlan救済：normalChat を必ず差し込む（配列を保持）
// - Record<string,true> に潰さない（render-v2 が本文を組めなくなる）
// - meta.framePlan.slots は “slot objects 配列” を入れる
// - slotPlanPolicy を meta / framePlan に必ず伝播
// =========================================================

const slotsRaw =
  (r as any).slotPlan?.slots ??
  (r as any).slotPlan ??
  null;

// slots は配列のまま扱う（toSlotRecord は使わない）
let slotsArr: any[] | null = Array.isArray(slotsRaw) ? slotsRaw : null;

// slotPlanPolicy を取得（postprocess / llmGate 用）
const slotPlanPolicyRaw =
  (r as any).slotPlan?.slotPlanPolicy ??
  (r as any).slotPlanPolicy ??
  null;

let slotPlanPolicy: string | null =
  typeof slotPlanPolicyRaw === 'string' && slotPlanPolicyRaw.trim()
    ? slotPlanPolicyRaw.trim()
    : null;

// SILENCE 判定（このブロック内で完結させる）
const speechAct = String((meta as any)?.speechAct ?? '').toUpperCase();
const speechAllowLLM = (meta as any)?.speechAllowLLM;
const isSilence = speechAct === 'SILENCE' || speechAllowLLM === false;

// 非SILENCEで slots が空なら normalChat を差し込む
if (
  !isSilence &&
  (!slotsArr || slotsArr.length === 0) &&
  String(text ?? '').trim().length > 0
) {
  const fallback = buildNormalChatSlotPlan({ userText: text });

  slotsArr = Array.isArray((fallback as any).slots)
    ? (fallback as any).slots
    : [];

  // ✅ ここが本命：fallback を入れたなら policy も確定させる
  const fp = (fallback as any).slotPlanPolicy;
  if (typeof fp === 'string' && fp.trim()) {
    slotPlanPolicy = fp.trim();
  } else if (!slotPlanPolicy) {
    slotPlanPolicy = 'SCAFFOLD';
  }

  (meta as any).slotPlanFallback = 'normalChat';
}



// framePlan は render-v2 が参照する唯一の正
(meta as any).framePlan = {
  frame: (r as any).frame ?? null,
  slots: slotsArr,          // ✅ 配列
  slotPlanPolicy,           // ✅ ここが本命
};

// 互換（V1 / llmGate / postprocess 用）
(meta as any).frame =
  (r as any).frame ?? (meta as any).frame ?? null;

(meta as any).slotPlan = slotsArr;        // 配列のまま
(meta as any).slotPlanPolicy = slotPlanPolicy;

if (typeof (r as any).tLayerModeActive === 'boolean') {
  (meta as any).tLayerModeActive = (r as any).tLayerModeActive;
}
if (
  typeof (r as any).tLayerHint === 'string' &&
  (r as any).tLayerHint.trim()
) {
  (meta as any).tLayerHint = (r as any).tLayerHint.trim();
}


    console.log('[IROS/ORCH][after-container]', {
      frame: (meta as any).frame ?? null,
      framePlan_frame: (meta as any).framePlan?.frame ?? null,
      descentGate: (meta as any).descentGate ?? null,
      slotPlanKeysLen:
        (meta as any).slotPlan && typeof (meta as any).slotPlan === 'object'
          ? Object.keys((meta as any).slotPlan).length
          : null,
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
    (meta as any).descentGateReason ?? (finalMeta as any).descentGateReason ?? null;

  (finalMeta as any).inputKind =
    (meta as any).inputKind ?? (finalMeta as any).inputKind ?? null;
  (finalMeta as any).frame = (meta as any).frame ?? (finalMeta as any).frame ?? null;
  (finalMeta as any).framePlan =
    (meta as any).framePlan ?? (finalMeta as any).framePlan ?? null;
  (finalMeta as any).slotPlan =
    (meta as any).slotPlan ?? (finalMeta as any).slotPlan ?? null;

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
