// file: src/lib/iros/orchestratorIntentTransition.ts
// I) Intent Transition v1.0 を orchestrator から切り出し（behavior-preserving）
// - orchestrator.ts の「7.80 Intent Transition v1.0」ブロックを関数化
// - 重要：ms の key揺れ吸収 / meta への確定反映 / goal/priority の C 抑制 までを保持
// - normalizeDepthStrict は orchestrator 側の同実装を注入（単一ソース）

import type { IrosMeta } from './system';

import { extractIntentSignals } from './intentTransition/signals';
import { runIntentTransition } from './intentTransition/transitionEngine';
import { INTENT_TRANSITION_POLICY_V1 } from './intentTransition/transitionPolicy';
import type { IntentTransitionState } from './intentTransition/types';

export type ApplyIntentTransitionArgs = {
  text: string;

  meta: IrosMeta;

  // BaseMeta 側から渡す（ms key揺れ吸収のため）
  ms: any;

  // continuity（直前確定）
  lastDepthForContinuity: any; // Depth | null だが依存型を増やさない
  lastSpinLoop: any; // SpinLoop | null

  // 7.80 で goal/priority の C 走りを抑制するために受け取る
  goal: any | null;
  priority: any | null;

  // Depth正規化の単一ソース
  normalizeDepthStrict: (d?: any) => any; // (Depth|...) => Depth|undefined
};

export type ApplyIntentTransitionResult = {
  meta: IrosMeta;
  goal: any | null;
  priority: any | null;

  itx: {
    decision: string;
    step: any;
    anchorEventType: any;
    reason: string | null;
    nextDepthStage: any | null;
    nextSpinLoop: any | null;
    nextTGate: any | null;
  };
};

export function applyIntentTransitionV1(
  args: ApplyIntentTransitionArgs,
): ApplyIntentTransitionResult {
  const {
    text,
    meta,
    ms,
    lastDepthForContinuity,
    lastSpinLoop,
    goal,
    priority,
    normalizeDepthStrict,
  } = args;

  // MemoryState のキー揺れを吸収（DB/保存層の命名差があっても安全）
  const msAny: any = ms ?? null;

  const readTGate = (): 'closed' | 'open' | undefined => {
    const v =
      (msAny?.t_gate ?? msAny?.tGate ?? (meta as any)?.tGate ?? undefined) as any;
    return v === 'closed' || v === 'open' ? v : undefined;
  };

  const readAnchorEventType = ():
    | 'none'
    | 'confirm'
    | 'set'
    | 'reset'
    | undefined => {
    const v =
      (msAny?.anchor_event_type ??
        msAny?.anchorEventType ??
        (meta as any)?.anchorEventType ??
        undefined) as any;
    return v === 'none' || v === 'confirm' || v === 'set' || v === 'reset'
      ? v
      : undefined;
  };

  const signals = extractIntentSignals(text);

  const itxState: IntentTransitionState = {
    // 直前確定（継続値）
    lastDepthStage: (lastDepthForContinuity ?? undefined) as any,
    lastSpinLoop: (lastSpinLoop ?? undefined) as any,

    // 今ターン暫定（ここから policy/engine で確定に寄せる）
    currentDepthStage: (meta.depth ?? undefined) as any,
    currentSpinLoop: (((meta as any).spinLoop ?? undefined) as any) ?? undefined,

    // 現在のゲート/アンカー状態
    tGate: readTGate(),
    anchorEventType: readAnchorEventType(),
  };

  const itx = runIntentTransition({
    state: itxState,
    signals,
    policy: INTENT_TRANSITION_POLICY_V1,
  });

  // --- meta に確定値として反映（LLM generate より前） ---
  if (itx.nextDepthStage) {
    meta.depth = normalizeDepthStrict(itx.nextDepthStage as any) ?? meta.depth;
  }
  if (itx.nextSpinLoop) {
    (meta as any).spinLoop = itx.nextSpinLoop;
  }
  if (itx.nextTGate) {
    (meta as any).tGate = itx.nextTGate;
  }

  // --- スナップショットを meta に載せる（persist が同じものを保存する） ---
  (meta as any).intentTransition = {
    decision: itx.decision,
    step: itx.snapshot.step,
    anchorEventType: itx.snapshot.anchorEventType,
    reason: itx.snapshot.reason,
  };

  // --- 重要：goal/priority が C に走っても、ITX が「まだ」を優先する ---
  const denyCommitToC =
    itx.decision === 'forbid_jump' || itx.decision === 'enter_idea_loop';

  if (denyCommitToC) {
    if (goal && typeof (goal as any).targetDepth === 'string') {
      const td = String((goal as any).targetDepth);
      if (td.startsWith('C')) (goal as any).targetDepth = meta.depth;
    }
    if (priority?.goal && typeof (priority.goal as any).targetDepth === 'string') {
      const td = String((priority.goal as any).targetDepth);
      if (td.startsWith('C')) (priority.goal as any).targetDepth = meta.depth;
    }
  }

  /* =========================================================
   * [IROS_ANCHOR_APPLY_FROM_ITX] Tで意図アンカーを反映
   * - itx.snapshot.anchorEventType を唯一の正とする
   * - set のときだけ anchorText が必要（無ければ何もしない）
   * ========================================================= */
  {
    const aType = itx.snapshot.anchorEventType as
      | 'none'
      | 'confirm'
      | 'set'
      | 'reset'
      | undefined;

    // 「Tで刺さった」時だけ反映したいなら、tGate/open を条件にする（任意）
    const tGate = itx.nextTGate ?? itxState.tGate; // open/closed/undefined
    const isTActive = tGate === 'open' || itx.snapshot.step === 't_open';

    // ★ reset：固定北（key持ち）は絶対に消さない（予約キー保護）
    if (isTActive && aType === 'reset') {
      const cur = (meta as any).intent_anchor ?? (meta as any).intentAnchor ?? null;
      const hasKey =
        cur &&
        typeof cur === 'object' &&
        typeof (cur as any).key === 'string' &&
        (cur as any).key.trim().length > 0;

      if (!hasKey) {
        (meta as any).intent_anchor = null;
      }
    }

    // ★ confirm は「書き換えない」（安全）
    if (isTActive && aType === 'confirm') {
      // ここでは intent_anchor を触らない
    }

    // ★ set は「アンカーテキストがある場合のみ」反映
    if (isTActive && aType === 'set') {
      const anchorTextRaw =
        (itx.snapshot as any)?.anchorText ?? (signals as any)?.anchorText ?? null;

      const anchorText =
        typeof anchorTextRaw === 'string' && anchorTextRaw.trim().length > 0
          ? anchorTextRaw.trim()
          : null;

      if (anchorText) {
        (meta as any).intent_anchor = {
          text: anchorText,
          fixed: false,
          strength: null,
          y_level:
            typeof (meta as any)?.yLevel === 'number' ? (meta as any).yLevel : null,
          h_level:
            typeof (meta as any)?.hLevel === 'number' ? (meta as any).hLevel : null,
        };
      }
    }
  }

  return {
    meta,
    goal,
    priority,
    itx: {
      decision: itx.decision,
      step: itx.snapshot.step,
      anchorEventType: itx.snapshot.anchorEventType,
      reason: itx.snapshot.reason ?? null,
      nextDepthStage: itx.nextDepthStage ?? null,
      nextSpinLoop: itx.nextSpinLoop ?? null,
      nextTGate: itx.nextTGate ?? null,
    },
  };
}
