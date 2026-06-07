import type { SupabaseClient } from '@supabase/supabase-js';

export type FlowPatternSourceType =
  | 'chat'
  | 'diagnosis'
  | 'diagnosis_followup'
  | 'clarification'
  | 'relationship'
  | 'field';

export type SaveFlowPatternSnapshotArgs = {
  supabase: SupabaseClient;
  userCode: string;
  conversationId?: string | null;
  messageId?: string | number | null;

  sourceType?: FlowPatternSourceType;
  sourceId?: string | number | null;

  userText?: string | null;
  assistantText?: string | null;

  meta?: any;
  metaForSave?: any;

  tags?: string[];
};

const cleanText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const head = (value: unknown, max = 240): string | null => {
  const text = cleanText(value).replace(/\n+/g, ' ');
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

const asText = (value: unknown, max = 160): string | null => {
  const text = head(value, max);
  return text || null;
};

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const asBigIntNumber = (value: unknown): number | null => {
  const n = asNumber(value);
  if (n === null) return null;
  return Number.isInteger(n) ? n : null;
};

const isUuidLike = (value: unknown): boolean => {
  const text = String(value ?? '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text);
};

const pickFirst = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    return value;
  }
  return null;
};

const asRecord = (value: unknown): Record<string, any> => {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
};

const uniqueTags = (values: unknown[]): string[] => {
  const out: string[] = [];

  for (const value of values.flat()) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
  }

  return out.slice(0, 16);
};

const safeMeta = (value: unknown): Record<string, any> => {
  const record = asRecord(value);

  return {
    source: 'saveFlowPatternSnapshot',
    traceId:
      record?.extra?.traceId ??
      record?.extra?.trace_id ??
      record?.traceId ??
      record?.trace_id ??
      null,
    presentationKind:
      record?.extra?.presentationKind ??
      record?.presentationKind ??
      null,
    inputKind:
      record?.extra?.inputKind ??
      record?.inputKind ??
      null,
    targetKind:
      record?.extra?.targetKind ??
      record?.extra?.target_kind ??
      record?.targetKind ??
      record?.target_kind ??
      null,
    memoryStateSnapshotExists: Boolean(
      record?.extra?.memoryStateSnapshot ??
      record?.extra?.ctxPack?.memoryStateSnapshot,
    ),
    ctxPackKeys:
      record?.extra?.ctxPack && typeof record.extra.ctxPack === 'object'
        ? Object.keys(record.extra.ctxPack).slice(0, 80)
        : [],
  };
};

export async function saveFlowPatternSnapshot(args: SaveFlowPatternSnapshotArgs): Promise<{
  ok: boolean;
  inserted?: boolean;
  id?: string | null;
  error?: unknown;
}> {
  const supabase = args.supabase;
  const userCode = cleanText(args.userCode);

  if (!supabase || !userCode) {
    return {
      ok: false,
      inserted: false,
      error: 'missing_supabase_or_user_code',
    };
  }

  const metaForSave = asRecord(args.metaForSave ?? args.meta);
  const extra = asRecord(metaForSave.extra);
  const ctxPack = asRecord(extra.ctxPack);
  const memoryStateSnapshot = asRecord(
    pickFirst(
      ctxPack.memoryStateSnapshot,
      extra.memoryStateSnapshot,
      metaForSave.memoryStateSnapshot,
    ),
  );

  const qCounts = asRecord(
    pickFirst(
      ctxPack.qCounts,
      extra.qCounts,
      memoryStateSnapshot.qCounts,
      memoryStateSnapshot.q_counts,
    ),
  );

  const sourceType = (asText(args.sourceType, 40) ?? 'chat') as FlowPatternSourceType;

  const conversationIdText = cleanText(args.conversationId);
  const conversationId = isUuidLike(conversationIdText) ? conversationIdText : null;

  const qCode = asText(
    pickFirst(
      ctxPack.qCode,
      ctxPack.q_code,
      memoryStateSnapshot.qCode,
      memoryStateSnapshot.q_code,
      metaForSave.qCode,
      metaForSave.q_code,
    ),
    40,
  );

  const qPrimary = asText(
    pickFirst(
      ctxPack.qPrimary,
      ctxPack.q_primary,
      memoryStateSnapshot.qPrimary,
      memoryStateSnapshot.q_primary,
      qCounts.q_primary,
      qCounts.qPrimary,
      extra.qPrimary,
      extra.q_primary,
      metaForSave.qPrimary,
      metaForSave.q_primary,
      extra.resonanceState?.qPrimary,
      extra.resonanceState?.q_primary,
      extra.mirrorFlowV1?.qPrimary,
      extra.mirrorFlowV1?.q_primary,
    ),
    40,
  );

  const eTurn = asText(
    pickFirst(
      ctxPack.eTurn,
      ctxPack.e_turn,
      qCounts.e_turn_now,
      qCounts.eTurnNow,
      qCounts.e_turn,
      qCounts.eTurn,
      extra.e_turn,
      extra.eTurn,
      metaForSave.e_turn,
      metaForSave.eTurn,
      extra.resonanceState?.e_turn,
      extra.resonanceState?.eTurn,
      extra.mirrorFlowV1?.e_turn,
      extra.mirrorFlowV1?.eTurn,
      extra.mirror?.e_turn,
      extra.mirror?.eTurn,
      extra.flowMirror?.e_turn,
      extra.flowMirror?.eTurn,
    ),
    40,
  );

  const depthStage = asText(
    pickFirst(
      ctxPack.depthStage,
      ctxPack.depth_stage,
      memoryStateSnapshot.depthStage,
      memoryStateSnapshot.depth_stage,
      metaForSave.depthStage,
      metaForSave.depth_stage,
    ),
    40,
  );

  const phase = asText(
    pickFirst(
      ctxPack.phase,
      memoryStateSnapshot.phase,
      metaForSave.phase,
    ),
    40,
  );

  const selfAcceptance = asNumber(
    pickFirst(
      ctxPack.selfAcceptance,
      ctxPack.self_acceptance,
      memoryStateSnapshot.selfAcceptance,
      memoryStateSnapshot.self_acceptance,
      metaForSave.selfAcceptance,
      metaForSave.self_acceptance,
    ),
  );

  const row = {
    user_code: userCode,
    conversation_id: conversationId,
    message_id: asBigIntNumber(args.messageId),

    source_type: sourceType,
    source_id: asText(args.sourceId, 80),

    target_label: asText(
      pickFirst(
        ctxPack.targetLabel,
        ctxPack.diagnosisFollowupTargetLabel,
        extra.targetLabel,
        extra.diagnosisFollowupTargetLabel,
      ),
      120,
    ),
    target_type: asText(
      pickFirst(
        ctxPack.targetType,
        extra.targetType,
      ),
      80,
    ),

    q_code: qCode,
    q_primary: qPrimary,
    e_turn: eTurn,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,

    relation_focus: asText(
      pickFirst(
        ctxPack.relationFocus,
        extra.relationFocus,
      ),
      120,
    ),
    emotional_temperature: asText(
      pickFirst(
        ctxPack.emotionalTemperature,
        extra.emotionalTemperature,
      ),
      120,
    ),

    observed_stage: asText(
      pickFirst(
        ctxPack.observedStage,
        extra.observedStage,
      ),
      80,
    ),
    primary_stage: asText(
      pickFirst(
        ctxPack.primaryStage,
        extra.primaryStage,
      ),
      80,
    ),
    secondary_stage: asText(
      pickFirst(
        ctxPack.secondaryStage,
        extra.secondaryStage,
      ),
      80,
    ),

    will_rotation: asText(
      pickFirst(
        ctxPack.willRotation,
        extra.willRotation,
      ),
      80,
    ),

    situation_topic: asText(
      pickFirst(
        ctxPack.situationTopic,
        extra.situationTopic,
        memoryStateSnapshot.situationTopic,
      ),
      160,
    ),
    situation_summary: asText(
      pickFirst(
        ctxPack.situationSummary,
        extra.situationSummary,
        memoryStateSnapshot.situationSummary,
      ),
      240,
    ),

    followup_kind: asText(
      pickFirst(
        ctxPack.followupKind,
        extra.followupKind,
      ),
      80,
    ),
    goal_kind: asText(
      pickFirst(
        ctxPack.goalKind,
        ctxPack.replyGoal?.kind,
        extra.goalKind,
      ),
      80,
    ),

    diagnosis_id: asBigIntNumber(
      pickFirst(
        ctxPack.diagnosisId,
        ctxPack.activeDiagnosisId,
        extra.diagnosisId,
        extra.activeDiagnosisId,
      ),
    ),
    diagnosis_text_head: head(
      pickFirst(
        ctxPack.lastIrDiagnosis?.diagnosisText,
        ctxPack.lastIrDiagnosis?.text,
        extra.lastIrDiagnosis?.diagnosisText,
        extra.lastIrDiagnosis?.text,
      ),
      240,
    ),
    user_text_head: head(args.userText, 240),
    assistant_text_head: head(args.assistantText, 240),

    tags: uniqueTags([
      args.tags ?? [],
      'iros',
      'flow_pattern',
      sourceType,
      depthStage,
      phase,
      qPrimary,
    ]),
    meta: safeMeta(metaForSave),
  };

  let rowForInsert: Record<string, any>;

  try {
    rowForInsert = JSON.parse(JSON.stringify(row));
  } catch (e) {
    return {
      ok: false,
      inserted: false,
      error: {
        message: 'flow_pattern_snapshot_row_json_stringify_failed',
        detail: e instanceof Error ? e.message : String(e),
      },
    };
  }

  const { data, error } = await (supabase as any)
    .from('iros_flow_pattern_snapshots')
    .insert(rowForInsert)
    .select('id')
    .single();

  if (error) {
    return {
      ok: false,
      inserted: false,
      error,
    };
  }

  return {
    ok: true,
    inserted: true,
    id: data?.id ?? null,
  };
}

