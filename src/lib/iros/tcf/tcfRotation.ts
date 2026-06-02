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

export type TcfTEvidenceInput = {
  meta?: any | null;
  extra?: any | null;
  ctxPack?: any | null;
  sriContext?: any | null;
  memoryState?: any | null;
  anchorEntry?: any | null;
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, any>;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }

  return null;
}

function firstTrue(...values: unknown[]): boolean {
  return values.some((value) => value === true);
}

function anchorEventValue(value: unknown): string | null {
  if (typeof value === 'string') return firstString(value);

  const record = asRecord(value);
  if (!record) return null;

  return firstString(record.type, record.event, record.anchorEvent, record.anchor_event_type);
}

function normalizeTcfAnchorEvent(value: unknown): TcfAnchorEvent | null {
  const event = firstString(anchorEventValue(value))?.toLowerCase() ?? null;

  if (
    event === 'choice' ||
    event === 'action' ||
    event === 'reconfirm' ||
    event === 'none'
  ) {
    return event;
  }

  return null;
}

function buildTcfTEvidenceReason(args: {
  itxStep: string | null;
  tEntryOk: boolean;
  hasCommittedAnchor: boolean;
  anchorEventRaw: string | null;
}): string | null {
  if (args.itxStep === 'T3') return 'ITX_STEP_T3';
  if (args.itxStep === 'T2') return 'ITX_STEP_T2';
  if (args.tEntryOk) return 'T_ENTRY_OK';
  if (args.hasCommittedAnchor) return 'COMMITTED_ANCHOR';

  if (args.anchorEventRaw && args.anchorEventRaw !== 'none') {
    return `ANCHOR_EVENT_${args.anchorEventRaw.toUpperCase()}`;
  }

  return null;
}

export function readTcfTEvidence(input: TcfTEvidenceInput): TcfTEvidence {
  const meta = asRecord(input.meta) ?? {};
  const extra = asRecord(input.extra) ?? asRecord(meta.extra) ?? {};
  const ctxPack =
    asRecord(input.ctxPack) ??
    asRecord(extra.ctxPack) ??
    asRecord(meta.ctxPack) ??
    {};

  const sriContext =
    asRecord(input.sriContext) ??
    asRecord(ctxPack.sriContext) ??
    asRecord(extra.sriContext) ??
    asRecord(meta.sriContext) ??
    {};

  const intentionContext =
    asRecord(sriContext.intentionContext) ??
    asRecord(sriContext.intentContext) ??
    {};

  const memoryState =
    asRecord(input.memoryState) ??
    asRecord(meta.memoryState) ??
    asRecord(extra.memoryState) ??
    asRecord(ctxPack.memoryState) ??
    {};

  const anchorEntry =
    asRecord(input.anchorEntry) ??
    asRecord(meta.anchorEntry) ??
    asRecord(extra.anchorEntry) ??
    asRecord(ctxPack.anchorEntry) ??
    {};

  const anchorPatch = asRecord(anchorEntry.patch) ?? {};

  const itxStep = firstString(
    meta.itx_step,
    meta.itxStep,
    extra.itx_step,
    extra.itxStep,
    ctxPack.itx_step,
    ctxPack.itxStep,
    sriContext.itx_step,
    sriContext.itxStep,
    intentionContext.itx_step,
    intentionContext.itxStep,
    memoryState.itx_step,
    memoryState.itxStep,
    anchorPatch.itx_step,
    anchorPatch.itxStep,
  );

  const anchorEventRaw = firstString(
    meta.anchor_event_type,
    meta.anchorEventType,
    meta.anchor_event,
    anchorEventValue(meta.anchorEvent),
    extra.anchor_event_type,
    extra.anchorEventType,
    extra.anchor_event,
    anchorEventValue(extra.anchorEvent),
    ctxPack.anchor_event_type,
    ctxPack.anchorEventType,
    ctxPack.anchor_event,
    anchorEventValue(ctxPack.anchorEvent),
    sriContext.anchor_event_type,
    sriContext.anchorEventType,
    sriContext.anchor_event,
    anchorEventValue(sriContext.anchorEvent),
    intentionContext.anchor_event_type,
    intentionContext.anchorEventType,
    intentionContext.anchor_event,
    anchorEventValue(intentionContext.anchorEvent),
    anchorEntry.anchorEvent,
    anchorEntry.anchor_event_type,
    anchorPatch.itx_anchor_event_type,
  )?.toLowerCase() ?? null;

  const anchorEvent = normalizeTcfAnchorEvent(anchorEventRaw);

  const tEntryOk = firstTrue(
    meta.t_entry_ok,
    meta.tEntryOk,
    extra.t_entry_ok,
    extra.tEntryOk,
    ctxPack.t_entry_ok,
    ctxPack.tEntryOk,
    sriContext.t_entry_ok,
    sriContext.tEntryOk,
    intentionContext.t_entry_ok,
    intentionContext.tEntryOk,
    anchorEntry.tEntryOk,
    anchorEntry.t_entry_ok,
  );

  const hasCommittedAnchor = firstTrue(
    meta.has_committed_anchor,
    meta.hasCommittedAnchor,
    extra.has_committed_anchor,
    extra.hasCommittedAnchor,
    ctxPack.has_committed_anchor,
    ctxPack.hasCommittedAnchor,
    sriContext.has_committed_anchor,
    sriContext.hasCommittedAnchor,
    intentionContext.has_committed_anchor,
    intentionContext.hasCommittedAnchor,
    memoryState.has_committed_anchor,
    memoryState.hasCommittedAnchor,
    asRecord(meta.intent_anchor)?.fixed,
    asRecord(extra.intent_anchor)?.fixed,
    asRecord(ctxPack.intent_anchor)?.fixed,
    asRecord(memoryState.intent_anchor)?.fixed,
  );

  const hasAnchorEvent = Boolean(anchorEventRaw && anchorEventRaw !== 'none');
  const hasT = Boolean(
    itxStep === 'T3' ||
      itxStep === 'T2' ||
      tEntryOk ||
      hasCommittedAnchor ||
      hasAnchorEvent,
  );

  return {
    hasT,
    itxStep,
    anchorEvent,
    hasCommittedAnchor,
    reason: buildTcfTEvidenceReason({
      itxStep,
      tEntryOk,
      hasCommittedAnchor,
      anchorEventRaw,
    }),
  };
}
