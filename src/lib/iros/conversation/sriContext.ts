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
  relationId: string | null;
  referenceTarget: string | null;
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
      ),
      depthStage: firstString(
        ctxPack.depthStage,
        ctxPack.depth_stage,
        memoryStateSnapshot.depthStage,
        memoryStateSnapshot.depth_stage,
      ),
      phase: firstString(
        ctxPack.phase,
        memoryStateSnapshot.phase,
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
    relationContext: {
      targetLabel: firstString(
        ctxPack.targetLabel,
        ctxPack.diagnosisFollowupTargetLabel,
        extra.targetLabel,
        relationship.targetLabel,
        relationship.displayName,
      ),
      relationId: firstString(
        ctxPack.relationId,
        relationship.relationId,
        relationshipMemory.relation_id,
        relationshipMemory.relationId,
      ),
      referenceTarget: firstString(
        ctxPack.referenceTarget,
        resolvedAskRecord.referenceTarget,
      ),
      resolvedAsk,
      relationshipMemoryNote: firstString(
        ctxPack.relationshipMemoryNote,
        ctxPack.relationshipMemoryNoteText,
        ctxPack.relationshipMemoryNoteForWriter,
      ),
      relationshipDomain: firstString(
        ctxPack.relationshipDomain,
        relationship.domain,
        relationship.relationshipDomain,
        relationship.relationshipGoal,
      ),
    },
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
