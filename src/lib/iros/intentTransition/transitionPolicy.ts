// file: src/lib/iros/intentTransition/transitionPolicy.ts
// iros - Intent Transition v1.0 (policy)
// - Declare non-negotiable constraints for transitions
// - R→C jump forbidden (unless anchor is set)
// - T gate requires behavioral evidence (choice/commit/repeat)
// - Commit/Create requires anchor set

import type { IntentTransitionPolicy } from './types';

export const INTENT_TRANSITION_POLICY_V1: IntentTransitionPolicy = {
  // v1.0: 最重要。ここが崩れると「進んだ実感」が消える
  forbidRtoCJump: true,

  // v1.0: 雰囲気ポジでは開かない
  tGateRequiresBehavioralEvidence: true,

  // v1.0: anchor set なしで C2/C3（運用）に入ると空回りする
  requireAnchorSetForCommit: true,
};
