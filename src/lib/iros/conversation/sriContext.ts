
function pickSriRelationStringIdentityV1(...values: any[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function buildSriRelationIdentityV1(ctxPack: any, extra: any, targetLabel: string | null) {
  const relationId = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.relationId,
    ctxPack?.relationshipCapture?.relationId,
    ctxPack?.relationId,
    extra?.relationshipContext?.relationId,
    extra?.relationshipCapture?.relationId,
    extra?.relationId,
  );

  const personId = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.personId,
    ctxPack?.relationshipCapture?.personId,
    ctxPack?.personId,
    extra?.relationshipContext?.personId,
    extra?.relationshipCapture?.personId,
    extra?.personId,
  );

  const displayName = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.displayName,
    ctxPack?.relationshipCapture?.displayName,
    ctxPack?.displayName,
    extra?.relationshipContext?.displayName,
    extra?.relationshipCapture?.displayName,
    extra?.displayName,
    targetLabel,
  );

  const referenceTarget = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.referenceTarget,
    ctxPack?.relationshipCapture?.referenceTarget,
    ctxPack?.referenceTarget,
    extra?.relationshipContext?.referenceTarget,
    extra?.relationshipCapture?.referenceTarget,
    extra?.referenceTarget,
    displayName,
    targetLabel,
  );

  const kind = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.kind,
    ctxPack?.relationshipCapture?.kind,
    extra?.relationshipContext?.kind,
    extra?.relationshipCapture?.kind,
  );

  const status = pickSriRelationStringIdentityV1(
    ctxPack?.relationshipContext?.status,
    ctxPack?.relationshipCapture?.status,
    extra?.relationshipContext?.status,
    extra?.relationshipCapture?.status,
  );

  return {
    displayName,
    personId,
    relationId,
    referenceTarget,
    kind,
    status,
    hasResolvedAsk: Boolean(targetLabel || relationId || referenceTarget),
  };
}
export type SriSelfState = {
  qCode: string | null;
  depthStage: string | null;
  phase: string | null;
  eTurn: string | null;
  currentFlow: string | null;
  previousFlow: string | null;
  returnStreak: number | null;
};

export type SriRelationContext = {
  targetLabel: string | null;
  displayName: string | null;
  personId: string | null;
  relationId: string | null;
  referenceTarget: string | null;
  kind: string | null;
  status: string | null;
  hasResolvedAsk: boolean;
  resolvedAsk: unknown | null;
  relationshipMemoryNote: string | null;
  relationshipDomain: string | null;
};

export type SriIntentionContext = {
  intentAnchor: unknown | null;
  itxStep: string | null;
  anchorEvent: string | null;
  goalKind: string | null;
  replyGoal: unknown | null;
  shiftKind: string | null;
  explicitUserSignal: unknown | null;
  willRotation: unknown | null;
};

export type SriContext = {
  selfState: SriSelfState;
  relationContext: SriRelationContext;
  intentionContext: SriIntentionContext;
};

function asRecord(v: unknown): Record<string, any> {
  return v && typeof v === 'object' ? (v as Record<string, any>) : {};
}

function strOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const v of values) {
    const s = strOrNull(v);
    if (s) return s;
  }
  return null;
}

export function buildSriContext(input: {
  ctxPack?: unknown;
  extra?: unknown;
  meta?: unknown;
}): SriContext {
  const ctxPack = asRecord(input.ctxPack);
  const extra = asRecord(input.extra);
  const meta = asRecord(input.meta);

  const flow = asRecord(ctxPack.flow);
  const memoryStateSnapshot = asRecord(ctxPack.memoryStateSnapshot);
  const resolvedAsk = ctxPack.resolvedAsk ?? extra.resolvedAsk ?? null;
  const resolvedAskRecord = asRecord(resolvedAsk);
  const relationship = asRecord(ctxPack.relationship);
  const relationshipMemory = asRecord(ctxPack.relationshipMemory);
  const intentAnchor =
    ctxPack.intentAnchor ??
    ctxPack.intent_anchor ??
    extra.intentAnchor ??
    extra.intent_anchor ??
    meta.intentAnchor ??
    meta.intent_anchor ??
    null;

  return {
    selfState: {
      qCode: firstString(
        ctxPack.qCode,
        ctxPack.q_code,
        memoryStateSnapshot.qPrimary,
        memoryStateSnapshot.qCode,
        memoryStateSnapshot.q_code,
        meta.qCode,
        meta.q_code,
        meta.qPrimary,
        meta.q_primary,
      ),
      depthStage: firstString(
        ctxPack.depthStage,
        ctxPack.depth_stage,
        memoryStateSnapshot.depthStage,
        memoryStateSnapshot.depth_stage,
        meta.depthStage,
        meta.depth_stage,
        meta.depth,
      ),
      phase: firstString(
        ctxPack.phase,
        memoryStateSnapshot.phase,
        meta.phase,
      ),
      eTurn: firstString(
        ctxPack.eTurn,
        ctxPack.e_turn,
        extra.eTurn,
        extra.e_turn,
        meta.eTurn,
        meta.e_turn,
      ),
      currentFlow: firstString(
        ctxPack.currentFlow,
        flow.currentFlow,
        flow.current,
        ctxPack.current_flow,
      ),
      previousFlow: firstString(
        ctxPack.previousFlow,
        flow.previousFlow,
        flow.previous,
        ctxPack.previous_flow,
      ),
      returnStreak: numOrNull(
        ctxPack.returnStreak ??
          ctxPack.return_streak ??
          flow.returnStreak ??
          flow.return_streak,
      ),
    },
    relationContext: (() => {
      const targetLabel = firstString(
        ctxPack.targetLabel,
        ctxPack.diagnosisFollowupTargetLabel,
        extra.targetLabel,
        relationship.targetLabel,
        relationship.displayName,
        ctxPack.relationshipContext?.targetLabel,
        ctxPack.relationshipCapture?.targetLabel,
        extra.relationshipContext?.targetLabel,
        extra.relationshipCapture?.targetLabel,
      );

      const identity = buildSriRelationIdentityV1(ctxPack, extra, targetLabel);

      return {
        targetLabel,
        displayName: identity.displayName,
        personId: identity.personId,
        relationId:
          identity.relationId ??
          firstString(
            ctxPack.relationId,
            relationship.relationId,
            relationshipMemory.relation_id,
            relationshipMemory.relationId,
          ),
        referenceTarget:
          identity.referenceTarget ??
          firstString(
            ctxPack.referenceTarget,
            resolvedAskRecord.referenceTarget,
          ),
        kind: identity.kind,
        status: identity.status,
        hasResolvedAsk:
          identity.hasResolvedAsk ||
          Boolean(
            targetLabel ||
              identity.relationId ||
              identity.referenceTarget ||
              resolvedAsk,
          ),
        resolvedAsk,
        relationshipMemoryNote: firstString(
          ctxPack.relationshipMemoryNote,
          ctxPack.relationshipMemoryNoteText,
          relationshipMemory.note,
          relationshipMemory.memoryNote,
          relationshipMemory.summary,
        ),
        relationshipDomain: firstString(
          ctxPack.relationshipDomain,
          relationship.domain,
          relationshipMemory.domain,
        ),
      };
    })(),
    intentionContext: {
      intentAnchor,
      itxStep: firstString(
        ctxPack.itxStep,
        ctxPack.itx_step,
        extra.itxStep,
        extra.itx_step,
        meta.itxStep,
        meta.itx_step,
      ),
      anchorEvent: firstString(
        ctxPack.anchorEvent,
        ctxPack.anchor_event,
        ctxPack.anchorEventType,
        ctxPack.anchor_event_type,
        extra.anchorEvent,
        extra.anchor_event,
        meta.anchorEvent,
        meta.anchor_event,
      ),
      goalKind: firstString(
        ctxPack.goalKind,
        extra.goalKind,
        meta.goalKind,
      ),
      replyGoal: ctxPack.replyGoal ?? extra.replyGoal ?? meta.replyGoal ?? null,
      shiftKind: firstString(
        ctxPack.shiftKind,
        extra.shiftKind,
        meta.shiftKind,
      ),
      explicitUserSignal:
        ctxPack.explicitUserSignal ??
        extra.explicitUserSignal ??
        meta.explicitUserSignal ??
        null,
      willRotation: ctxPack.willRotation ?? extra.willRotation ?? meta.willRotation ?? null,
    },
  };
}

