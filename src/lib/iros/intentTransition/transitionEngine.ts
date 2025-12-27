// file: src/lib/iros/intentTransition/transitionEngine.ts
// iros - Intent Transition v1.0 (engine) — FIXED/CONFIRMED
// - Depth axis: S / R / I / T / C（F/Uなし）
// - SpinLoop axis: SRI / TCF（この2つのみ）
// - Enforce: R→C jump forbidden (unless anchor is set)
// - I loop continues until T opens by behavioral evidence
// - Commit/Create requires anchor set (for C2/C3 etc.)

import type {
  AnchorEventType,
  DepthStage,
  IntentSignals,
  IntentTransitionPolicy,
  IntentTransitionResult,
  IntentTransitionState,
  IntentTransitionStep,
  SpinLoop,
  TGateState,
  TransitionDecisionKind,
} from './types';

function normAnchor(a?: AnchorEventType): AnchorEventType {
  return a ?? 'none';
}
function normTGate(g?: TGateState): TGateState {
  return g ?? 'closed';
}
function normSpin(s?: SpinLoop): SpinLoop {
  return s ?? 'SRI';
}

// DepthStage prefix checks (v1.0 minimal) — SRITC only
function depthGroup(d?: DepthStage): 'S' | 'R' | 'I' | 'T' | 'C' {
  const c = String(d ?? '').trim().toUpperCase();
  if (!c) return 'S'; // 未設定は安全側
  if (c.startsWith('S')) return 'S';
  if (c.startsWith('R')) return 'R';
  if (c.startsWith('I')) return 'I';
  if (c.startsWith('T')) return 'T';
  if (c.startsWith('C')) return 'C';
  return 'S'; // 不明も安全側
}

function stepFromDepth(d?: DepthStage): IntentTransitionStep {
  const g = depthGroup(d);
  if (g === 'S' || g === 'R') return 'recognize';
  if (g === 'I') return 'idea_loop';
  if (g === 'T') return 't_open';
  if (g === 'C') return 'create';
  return 'recognize';
}

function hasBehavioralTProof(sig: IntentSignals): boolean {
  return sig.hasChoiceEvidence || sig.hasCommitEvidence || sig.hasRepeatEvidence;
}

function buildResult(args: {
  decision: TransitionDecisionKind;
  nextDepthStage?: DepthStage;
  nextSpinLoop?: SpinLoop;
  nextTGate?: TGateState;
  step: IntentTransitionStep;
  anchorEventType: AnchorEventType;
  reason: string;
  forbidJumpApplied?: boolean;
}): IntentTransitionResult {
  const {
    decision,
    nextDepthStage,
    nextSpinLoop,
    nextTGate,
    step,
    anchorEventType,
    reason,
    forbidJumpApplied,
  } = args;

  return {
    decision,
    nextDepthStage,
    nextSpinLoop,
    nextTGate,
    snapshot: { step, anchorEventType, reason },
    debug: { forbidJumpApplied },
  };
}

export function runIntentTransition(params: {
  state: IntentTransitionState;
  signals: IntentSignals;
  policy: IntentTransitionPolicy;
}): IntentTransitionResult {
  const { state, signals, policy } = params;

  const lastDepth = state.lastDepthStage;
  const curDepth = state.currentDepthStage ?? state.lastDepthStage;

  const curSpin = normSpin(state.currentSpinLoop ?? state.lastSpinLoop);
  const curTGate = normTGate(state.tGate);
  const curAnchor = normAnchor(state.anchorEventType);

  const lastGroup = depthGroup(lastDepth);
  const curGroup = depthGroup(curDepth);

  const anchorIsSet = curAnchor === 'set' || curAnchor === 'confirm';

  // 0) reset evidence always wins
  if (signals.hasResetEvidence) {
    return buildResult({
      decision: 'stay',
      nextSpinLoop: curSpin,
      nextTGate: 'closed',
      step: 'recognize',
      anchorEventType: 'reset',
      reason: 'reset_evidence',
    });
  }

  // 1) Enforce "R→C jump forbid"（仕様どおり：Rのみ）
  if (policy.forbidRtoCJump) {
    const isRtoCJump = lastGroup === 'R' && curGroup === 'C';
    if (isRtoCJump && !anchorIsSet) {
      return buildResult({
        decision: 'forbid_jump',
        nextSpinLoop: 'SRI',
        nextTGate: 'closed',
        step: 'idea_loop',
        anchorEventType: 'none',
        reason: 'forbid_r_to_c_jump_enter_idea_loop',
        forbidJumpApplied: true,
      });
    }
  }

  // 2) Execution requested but anchor not set → force I loop（Sofia寄せの核）
  if (signals.wantsExecution && policy.requireAnchorSetForCommit && !anchorIsSet) {
    return buildResult({
      decision: 'enter_idea_loop',
      nextSpinLoop: 'SRI',
      nextTGate: 'closed',
      step: 'idea_loop',
      anchorEventType: 'none',
      reason: 'execution_requested_but_anchor_not_set_enter_idea_loop',
    });
  }

  // 3) I loop continuation until T opens
  const isInIdeaLoop = curGroup === 'I' || stepFromDepth(curDepth) === 'idea_loop';
  if (signals.wantsIdeas || isInIdeaLoop) {
    // 3-a) T gate can open only by behavioral evidence
    if (policy.tGateRequiresBehavioralEvidence && hasBehavioralTProof(signals)) {
      const ev: AnchorEventType = signals.hasCommitEvidence
        ? 'set'
        : signals.hasChoiceEvidence
          ? 'confirm'
          : 'confirm';

      return buildResult({
        decision: 'open_t_gate',
        nextSpinLoop: 'TCF', // T 以降は TCF 側で扱う
        nextTGate: 'open',
        step: 't_open',
        anchorEventType: ev,
        reason: signals.hasCommitEvidence
          ? 't_open_by_commit'
          : signals.hasChoiceEvidence
            ? 't_open_by_choice'
            : 't_open_by_repeat',
      });
    }

    // 3-b) otherwise keep T closed and continue idea loop
    return buildResult({
      decision: 'stay',
      nextSpinLoop: 'SRI',
      nextTGate: 'closed',
      step: 'idea_loop',
      anchorEventType: curAnchor,
      reason: signals.wantsIdeas ? 'continue_idea_loop' : 'idea_loop_waiting_for_t',
    });
  }

  // 4) If T is open and anchor is set, keep it open and wait
  if (curTGate === 'open' && anchorIsSet) {
    return buildResult({
      decision: 'stay',
      nextSpinLoop: 'TCF',
      nextTGate: 'open',
      step: 't_open',
      anchorEventType: curAnchor,
      reason: 't_open_waiting_for_commit',
    });
  }

  // 5) Default stay
  return buildResult({
    decision: 'stay',
    nextSpinLoop: curSpin,
    nextTGate: curTGate,
    step: stepFromDepth(curDepth),
    anchorEventType: curAnchor,
    reason: 'no_transition',
  });
}
