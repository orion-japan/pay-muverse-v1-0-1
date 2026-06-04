export type ActiveContextAnchorKind =
  | 'diagnosis'
  | 'relationship'
  | 'previous_event';

export type ActiveContextEntityKind =
  | 'self'
  | 'person'
  | 'group'
  | 'diagnosis'
  | 'relationship'
  | 'previous_event'
  | 'document'
  | 'topic';

export type ActiveContextEdgeKind =
  | 'about'
  | 'refers_to'
  | 'diagnosis_of'
  | 'relationship_between'
  | 'member_of'
  | 'compared_with'
  | 'deepens'
  | 'followup_of'
  | 'derived_from'
  | 'mentions';

export type ActiveContextClarificationKind =
  | 'diagnosis_target'
  | 'relationship_target'
  | 'previous_event_target'
  | null;

export type ActiveContextEntity = {
  id: string;
  kind: ActiveContextEntityKind;
  label: string | null;
  key?: string | null;
  sourceId?: string | null;
  sourceText?: string | null;
  meta?: Record<string, any> | null;
};

export type ActiveContextEdge = {
  id: string;
  kind: ActiveContextEdgeKind;
  from: string;
  to: string;
  label?: string | null;
  meta?: Record<string, any> | null;
};

export type ActiveContextFrame = {
  version: 'active_context_frame_v1';
  primaryEntityId: string | null;
  entities: ActiveContextEntity[];
  edges: ActiveContextEdge[];
  lastAction?: string | null;
  followupRequest?: string | null;
  createdAt?: string | null;
};

// v1互換：既存の単体アンカーも残す
export type ActiveContextAnchor = {
  version: 'active_context_anchor_v1';
  kind: ActiveContextAnchorKind;
  targetLabel: string | null;
  targetKey?: string | null;
  relationId?: string | null;
  activeDiagnosisId?: string | null;
  sourceText?: string | null;
  sourceSummary?: string | null;
  lastAction?: string | null;
  followupRequest?: string | null;
  createdAt?: string | null;
};

function asObject(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : null;
}

function cleanString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > 0 ? s : null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    const picked = cleanString(value);
    if (picked) return picked;
  }
  return null;
}

function normalizeIdPart(value: unknown): string {
  const s = cleanString(value) ?? 'unknown';
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

function makeEntityId(kind: ActiveContextEntityKind, key: unknown, label: unknown): string {
  return `${kind}:${normalizeIdPart(key ?? label)}`;
}

function makeEdgeId(kind: ActiveContextEdgeKind, from: string, to: string): string {
  return `${kind}:${from}->${to}`;
}

function uniqueEntities(entities: ActiveContextEntity[]): ActiveContextEntity[] {
  const map = new Map<string, ActiveContextEntity>();

  for (const entity of entities) {
    if (!entity?.id) continue;
    const existing = map.get(entity.id);
    if (!existing) {
      map.set(entity.id, entity);
      continue;
    }

    map.set(entity.id, {
      ...existing,
      ...entity,
      label: entity.label ?? existing.label,
      key: entity.key ?? existing.key,
      sourceId: entity.sourceId ?? existing.sourceId,
      sourceText: entity.sourceText ?? existing.sourceText,
      meta: {
        ...(existing.meta ?? {}),
        ...(entity.meta ?? {}),
      },
    });
  }

  return Array.from(map.values());
}

function uniqueEdges(edges: ActiveContextEdge[]): ActiveContextEdge[] {
  const map = new Map<string, ActiveContextEdge>();

  for (const edge of edges) {
    if (!edge?.id || !edge.from || !edge.to) continue;
    const existing = map.get(edge.id);
    map.set(edge.id, {
      ...(existing ?? {}),
      ...edge,
      meta: {
        ...(existing?.meta ?? {}),
        ...(edge.meta ?? {}),
      },
    });
  }

  return Array.from(map.values());
}

export function pickDiagnosisSourceText(args: {
  lastIrDiagnosis?: unknown;
  irMeta?: unknown;
  fallbackText?: unknown;
}): string | null {
  const last = asObject(args.lastIrDiagnosis);
  const irMeta = asObject(args.irMeta);

  return pickString(
    last?.summary,
    last?.diagnosisText,
    last?.text,
    last?.assistantText,
    last?.observation,
    last?.state,
    irMeta?.summaryText,
    irMeta?.observationResult,
    irMeta?.awarenessText,
    args.fallbackText
  );
}

export function buildDiagnosisActiveContextAnchor(args: {
  targetLabel?: unknown;
  targetKey?: unknown;
  activeDiagnosisId?: unknown;
  lastIrDiagnosis?: unknown;
  irMeta?: unknown;
  sourceText?: unknown;
  followupRequest?: unknown;
  lastAction?: unknown;
  createdAt?: unknown;
}): ActiveContextAnchor | null {
  const last = asObject(args.lastIrDiagnosis);
  const irMeta = asObject(args.irMeta);

  const targetLabel = pickString(
    args.targetLabel,
    last?.targetLabel,
    last?.target,
    irMeta?.targetLabel,
    irMeta?.target
  );

  const sourceText = pickDiagnosisSourceText({
    lastIrDiagnosis: args.lastIrDiagnosis,
    irMeta: args.irMeta,
    fallbackText: args.sourceText,
  });

  if (!targetLabel && !sourceText) return null;

  return {
    version: 'active_context_anchor_v1',
    kind: 'diagnosis',
    targetLabel,
    targetKey: pickString(args.targetKey, last?.targetKey, irMeta?.targetKey),
    activeDiagnosisId: pickString(args.activeDiagnosisId, last?.id, last?.diagnosisResultId),
    sourceText,
    sourceSummary: sourceText,
    lastAction: pickString(args.lastAction) ?? 'diagnosis_followup',
    followupRequest: cleanString(args.followupRequest),
    createdAt: pickString(args.createdAt, last?.createdAt, last?.created_at),
  };
}

export function buildDiagnosisActiveContextFrame(args: {
  targetLabel?: unknown;
  targetKey?: unknown;
  activeDiagnosisId?: unknown;
  lastIrDiagnosis?: unknown;
  irMeta?: unknown;
  sourceText?: unknown;
  followupRequest?: unknown;
  lastAction?: unknown;
  createdAt?: unknown;
}): ActiveContextFrame | null {
  const anchor = buildDiagnosisActiveContextAnchor(args);
  if (!anchor) return null;

  const personId = makeEntityId(
    anchor.targetLabel === '自分' ? 'self' : 'person',
    anchor.targetKey,
    anchor.targetLabel
  );

  const diagnosisId = makeEntityId(
    'diagnosis',
    anchor.activeDiagnosisId ?? anchor.targetKey,
    anchor.targetLabel
  );

  const entities: ActiveContextEntity[] = [
    {
      id: personId,
      kind: anchor.targetLabel === '自分' ? 'self' : 'person',
      label: anchor.targetLabel,
      key: anchor.targetKey ?? null,
    },
    {
      id: diagnosisId,
      kind: 'diagnosis',
      label: anchor.targetLabel ? `${anchor.targetLabel}のir診断` : 'ir診断',
      key: anchor.activeDiagnosisId ?? anchor.targetKey ?? null,
      sourceId: anchor.activeDiagnosisId ?? null,
      sourceText: anchor.sourceText ?? null,
      meta: {
        activeDiagnosisId: anchor.activeDiagnosisId ?? null,
      },
    },
  ];

  const edges: ActiveContextEdge[] = [
    {
      id: makeEdgeId('diagnosis_of', diagnosisId, personId),
      kind: 'diagnosis_of',
      from: diagnosisId,
      to: personId,
      label: '診断対象',
    },
  ];

  return {
    version: 'active_context_frame_v1',
    primaryEntityId: diagnosisId,
    entities: uniqueEntities(entities),
    edges: uniqueEdges(edges),
    lastAction: anchor.lastAction ?? 'diagnosis_followup',
    followupRequest: anchor.followupRequest ?? null,
    createdAt: anchor.createdAt ?? null,
  };
}

export function buildRelationshipActiveContextAnchor(args: {
  relationshipMemory?: unknown;
  targetLabel?: unknown;
  targetKey?: unknown;
  relationId?: unknown;
  sourceText?: unknown;
  lastAction?: unknown;
  createdAt?: unknown;
}): ActiveContextAnchor | null {
  const memory = asObject(args.relationshipMemory);

  const targetLabel = pickString(
    args.targetLabel,
    memory?.displayName,
    memory?.display_name,
    memory?.targetLabel,
    memory?.name
  );

  const targetKey = pickString(
    args.targetKey,
    memory?.targetKey,
    memory?.target_key,
    Array.isArray(memory?.aliases) ? memory?.aliases?.[0] : null
  );

  const relationId = pickString(
    args.relationId,
    memory?.relationId,
    memory?.relation_id,
    memory?.id
  );

  const sourceText = pickString(
    args.sourceText,
    memory?.summary,
    memory?.note,
    memory?.relationshipMemoryNote,
    memory?.userReactionPattern,
    memory?.unresolvedTopics
  );

  if (!targetLabel && !targetKey && !relationId) return null;

  return {
    version: 'active_context_anchor_v1',
    kind: 'relationship',
    targetLabel,
    targetKey,
    relationId,
    sourceText,
    sourceSummary: sourceText,
    lastAction: pickString(args.lastAction) ?? 'relationship_reference',
    createdAt: pickString(args.createdAt, memory?.createdAt, memory?.created_at),
  };
}

export function buildRelationshipActiveContextFrame(args: {
  relationshipMemory?: unknown;
  targetLabel?: unknown;
  targetKey?: unknown;
  relationId?: unknown;
  sourceText?: unknown;
  lastAction?: unknown;
  createdAt?: unknown;
}): ActiveContextFrame | null {
  const anchor = buildRelationshipActiveContextAnchor(args);
  if (!anchor) return null;

  const personId = makeEntityId('person', anchor.targetKey ?? anchor.relationId, anchor.targetLabel);
  const relationId = makeEntityId('relationship', anchor.relationId ?? anchor.targetKey, anchor.targetLabel);

  const entities: ActiveContextEntity[] = [
    {
      id: personId,
      kind: 'person',
      label: anchor.targetLabel,
      key: anchor.targetKey ?? null,
      sourceId: anchor.relationId ?? null,
    },
    {
      id: relationId,
      kind: 'relationship',
      label: anchor.targetLabel ? `${anchor.targetLabel}との関係` : '関係性',
      key: anchor.relationId ?? anchor.targetKey ?? null,
      sourceId: anchor.relationId ?? null,
      sourceText: anchor.sourceText ?? null,
    },
  ];

  const edges: ActiveContextEdge[] = [
    {
      id: makeEdgeId('relationship_between', relationId, personId),
      kind: 'relationship_between',
      from: relationId,
      to: personId,
      label: '関係対象',
    },
  ];

  return {
    version: 'active_context_frame_v1',
    primaryEntityId: relationId,
    entities: uniqueEntities(entities),
    edges: uniqueEdges(edges),
    lastAction: anchor.lastAction ?? 'relationship_reference',
    createdAt: anchor.createdAt ?? null,
  };
}

export function mergeActiveContextFrames(
  ...frames: Array<ActiveContextFrame | null | undefined>
): ActiveContextFrame | null {
  const validFrames = frames.filter(Boolean) as ActiveContextFrame[];
  if (validFrames.length === 0) return null;

  const latest = validFrames[validFrames.length - 1];

  return {
    version: 'active_context_frame_v1',
    primaryEntityId: latest.primaryEntityId ?? validFrames.find((f) => f.primaryEntityId)?.primaryEntityId ?? null,
    entities: uniqueEntities(validFrames.flatMap((frame) => frame.entities ?? [])),
    edges: uniqueEdges(validFrames.flatMap((frame) => frame.edges ?? [])),
    lastAction: latest.lastAction ?? null,
    followupRequest: latest.followupRequest ?? null,
    createdAt: latest.createdAt ?? null,
  };
}

export function detectActiveContextClarification(userText: unknown): ActiveContextClarificationKind {
  const text = cleanString(userText) ?? '';

  if (
    /誰の診断|だれの診断|何の診断|どの診断|診断対象|対象は誰|対象はだれ|誰を深め|だれを深め|何を深め|どれを深め/u.test(
      text
    )
  ) {
    return 'diagnosis_target';
  }

  if (
    /誰のこと|だれのこと|誰について|だれについて|どの人|その人って誰|その人は誰|相手は誰|相手はだれ/u.test(
      text
    )
  ) {
    return 'relationship_target';
  }

  if (/さっきの何|前の何|どの話|何の続き|どの続き|さっきの続き/u.test(text)) {
    return 'previous_event_target';
  }

  return null;
}

function getPrimaryEntity(frame: ActiveContextFrame): ActiveContextEntity | null {
  return (
    frame.entities.find((entity) => entity.id === frame.primaryEntityId) ??
    frame.entities[0] ??
    null
  );
}

function findDiagnosisTarget(frame: ActiveContextFrame): ActiveContextEntity | null {
  const primary = getPrimaryEntity(frame);
  if (!primary) return null;

  const edge = frame.edges.find(
    (item) => item.kind === 'diagnosis_of' && item.from === primary.id
  );

  if (!edge) return null;
  return frame.entities.find((entity) => entity.id === edge.to) ?? null;
}

export function buildActiveContextClarificationReply(args: {
  anchor?: unknown;
  frame?: unknown;
  userText?: unknown;
}): string | null {
  const kind = detectActiveContextClarification(args.userText);
  if (!kind) return null;

  const frame = isActiveContextFrame(args.frame)
    ? args.frame
    : isActiveContextAnchor(args.anchor)
      ? activeContextAnchorToFrame(args.anchor)
      : null;

  if (!frame) return null;

  if (kind === 'diagnosis_target') {
    const diagnosis = getPrimaryEntity(frame);
    const target = diagnosis?.kind === 'diagnosis'
      ? findDiagnosisTarget(frame)
      : null;

    if (diagnosis?.kind === 'diagnosis') {
      const rawLabel = cleanString(target?.label) ?? '対象未指定';
      const strippedLabel = rawLabel
        .replace(/」を受けて、その内容を少し深めていました.*$/u, '')
        .replace(/のir診断$/u, '')
        .trim();

      const label =
        rawLabel === '対象未指定'
          ? rawLabel
          : rawLabel.includes('自分')
            ? '自分'
            : strippedLabel || rawLabel;

      return `${label}の診断です。さっきの「ir診断 ${label}」を受けて、その内容を少し深めていました。`;
    }
  }

  if (kind === 'relationship_target') {
    const primary = getPrimaryEntity(frame);
    const label = cleanString(primary?.label) ?? '対象未指定';

    if (primary?.kind === 'relationship' || primary?.kind === 'person' || primary?.kind === 'group') {
      return `直前に見ていたのは「${label}」についての文脈です。`;
    }
  }

  if (kind === 'previous_event_target') {
    const primary = getPrimaryEntity(frame);
    const label = cleanString(primary?.label) ?? '直前の内容';
    return `直前に扱っていたのは「${label}」です。`;
  }

  return null;
}

export function activeContextAnchorToFrame(anchor: ActiveContextAnchor): ActiveContextFrame | null {
  if (anchor.kind === 'diagnosis') {
    return buildDiagnosisActiveContextFrame({
      targetLabel: anchor.targetLabel,
      targetKey: anchor.targetKey,
      activeDiagnosisId: anchor.activeDiagnosisId,
      sourceText: anchor.sourceText,
      followupRequest: anchor.followupRequest,
      lastAction: anchor.lastAction,
      createdAt: anchor.createdAt,
    });
  }

  if (anchor.kind === 'relationship') {
    return buildRelationshipActiveContextFrame({
      targetLabel: anchor.targetLabel,
      targetKey: anchor.targetKey,
      relationId: anchor.relationId,
      sourceText: anchor.sourceText,
      lastAction: anchor.lastAction,
      createdAt: anchor.createdAt,
    });
  }

  if (anchor.kind === 'previous_event') {
    const id = makeEntityId('previous_event', anchor.targetKey, anchor.targetLabel);
    return {
      version: 'active_context_frame_v1',
      primaryEntityId: id,
      entities: [
        {
          id,
          kind: 'previous_event',
          label: anchor.targetLabel ?? '直前の内容',
          key: anchor.targetKey ?? null,
          sourceText: anchor.sourceText ?? null,
        },
      ],
      edges: [],
      lastAction: anchor.lastAction ?? 'previous_event_reference',
      createdAt: anchor.createdAt ?? null,
    };
  }

  return null;
}

export function isActiveContextAnchor(value: unknown): value is ActiveContextAnchor {
  const obj = asObject(value);
  if (!obj) return false;
  return (
    obj.version === 'active_context_anchor_v1' &&
    (obj.kind === 'diagnosis' ||
      obj.kind === 'relationship' ||
      obj.kind === 'previous_event')
  );
}

export function isActiveContextFrame(value: unknown): value is ActiveContextFrame {
  const obj = asObject(value);
  if (!obj) return false;
  return (
    obj.version === 'active_context_frame_v1' &&
    Array.isArray(obj.entities) &&
    Array.isArray(obj.edges)
  );
}
