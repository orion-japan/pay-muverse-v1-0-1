export type TcfUserReaction =
  | 'accept'
  | 'reject'
  | 'refine'
  | 'ask_more'
  | 'action'
  | 'confused'
  | 'unknown';

export type TcfConvergenceState =
  | 'none'
  | 'focused'
  | 'partial'
  | 'converged'
  | 'diverged'
  | 'recycle';

export type TcfCDirection =
  | 'none'
  | 'concretize'
  | 'structure_design'
  | 'implementation'
  | 'action_plan'
  | 'relation_boundary'
  | 'diagnosis_deepen'
  | 'memory_seed'
  | 'writer_correction';

export type TcfAnchorEvent =
  | 'choice'
  | 'action'
  | 'reconfirm'
  | 'none';

export type TcfTEvidence = {
  hasT: boolean;
  itxStep: string | null;
  anchorEvent: TcfAnchorEvent | null;
  hasCommittedAnchor: boolean;
  reason: string | null;
};

export type TcfRotationDecision = {
  previousFocus: string | null;
  currentFocus: string | null;
  nextFocus: string | null;
  tEvidence: TcfTEvidence;
  cDirection: TcfCDirection;
  userReaction: TcfUserReaction;
  convergence: TcfConvergenceState;
  shouldPersistFocus: boolean;
  shouldRebuildFocus: boolean;
  shouldPromoteDepth: boolean;
  shouldRouteToC: boolean;
  shouldUseTcfPattern: boolean;
  writerPatternKey: string | null;
  surfacePlanKind: string | null;
  reason: string;
};
