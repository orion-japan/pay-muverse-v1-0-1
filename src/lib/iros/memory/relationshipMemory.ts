// src/lib/iros/memory/relationshipMemory.ts
// iros — Relationship Memory store v1
// 役割：関係単位の記憶を DB に保存（UPSERT）

import { createClient } from '@supabase/supabase-js';
import type {
  RelationshipFact,
  RelationshipMemoryRow,
  RelationshipPattern,
  UpsertRelationshipMemoryInput,
} from './relationshipMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function uniqStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((v) => String(v ?? '').trim())
        .filter(Boolean)
    )
  );
}

function mergeStringArray(
  prev: string[] | null | undefined,
  next: string[] | null | undefined,
): string[] | null {
  const merged = uniqStrings([...(prev ?? []), ...(next ?? [])]);
  return merged.length > 0 ? merged : null;
}

function mergeFacts(
  prev: RelationshipFact[] | null | undefined,
  next: RelationshipFact[] | null | undefined,
): RelationshipFact[] | null {
  const rows = [...(prev ?? []), ...(next ?? [])];
  if (!rows.length) return null;

  const map = new Map<string, RelationshipFact>();

  for (const row of rows) {
    const key = String(row?.key ?? '').trim();
    const value = String(row?.value ?? '').trim();
    if (!key || !value) continue;

    map.set(key, {
      key,
      value,
      updatedAt:
        typeof row?.updatedAt === 'string' && row.updatedAt.trim()
          ? row.updatedAt.trim()
          : null,
    });
  }

  const out = Array.from(map.values());
  return out.length > 0 ? out : null;
}

function mergePatterns(
  prev: RelationshipPattern[] | null | undefined,
  next: RelationshipPattern[] | null | undefined,
): RelationshipPattern[] | null {
  const rows = [...(prev ?? []), ...(next ?? [])];
  if (!rows.length) return null;

  const map = new Map<string, RelationshipPattern>();

  for (const row of rows) {
    const key = String(row?.key ?? '').trim();
    if (!key) continue;

    const existing = map.get(key);

    map.set(key, {
      key,
      note:
        typeof row?.note === 'string' && row.note.trim()
          ? row.note.trim()
          : existing?.note ?? null,
      confidence:
        typeof row?.confidence === 'number'
          ? row.confidence
          : existing?.confidence ?? null,
    });
  }

  const out = Array.from(map.values());
  return out.length > 0 ? out : null;
}

function toRow(input: UpsertRelationshipMemoryInput): RelationshipMemoryRow {
  return {
    user_code: input.userCode,
    relation_id: input.relationId,

    display_name:
      typeof input.displayName === 'string' && input.displayName.trim()
        ? input.displayName.trim()
        : null,

    aliases: mergeStringArray(null, input.aliases ?? null),

    role:
      typeof input.role === 'string' && input.role.trim()
        ? input.role.trim()
        : null,

    facts: mergeFacts(null, input.facts ?? null),
    patterns: mergePatterns(null, input.patterns ?? null),

    safe_openers: mergeStringArray(null, input.safeOpeners ?? null),
    pressure_triggers: mergeStringArray(null, input.pressureTriggers ?? null),
    user_reaction_pattern: mergeStringArray(null, input.userReactionPattern ?? null),
    unresolved_topics: mergeStringArray(null, input.unresolvedTopics ?? null),

    confidence:
      typeof input.confidence === 'number' ? input.confidence : null,
  };
}

function mergeRows(
  prev: RelationshipMemoryRow | null,
  next: RelationshipMemoryRow,
): RelationshipMemoryRow {
  if (!prev) return next;

  return {
    ...prev,
    user_code: next.user_code,
    relation_id: next.relation_id,

    display_name: next.display_name ?? prev.display_name ?? null,
    aliases: mergeStringArray(prev.aliases, next.aliases),

    role: next.role ?? prev.role ?? null,

    facts: mergeFacts(prev.facts, next.facts),
    patterns: mergePatterns(prev.patterns, next.patterns),

    safe_openers: mergeStringArray(prev.safe_openers, next.safe_openers),
    pressure_triggers: mergeStringArray(prev.pressure_triggers, next.pressure_triggers),
    user_reaction_pattern: mergeStringArray(prev.user_reaction_pattern, next.user_reaction_pattern),
    unresolved_topics: mergeStringArray(prev.unresolved_topics, next.unresolved_topics),

    confidence:
      typeof next.confidence === 'number'
        ? next.confidence
        : prev.confidence ?? null,
  };
}

export async function loadRelationshipMemoryByRelationId(args: {
  userCode: string;
  relationId: string;
}): Promise<RelationshipMemoryRow | null> {
  const { userCode, relationId } = args;

  const { data, error } = await supabase
    .from('iros_relationship_memory')
    .select('*')
    .eq('user_code', userCode)
    .eq('relation_id', relationId)
    .maybeSingle();

  if (error) {
    console.error('[IROS/REL_MEMORY][LOAD_ERROR]', error);
    return null;
  }

  return (data as RelationshipMemoryRow | null) ?? null;
}

export async function upsertRelationshipMemory(args: UpsertRelationshipMemoryInput) {
  const nextRow = toRow(args);

  const prevRow = await loadRelationshipMemoryByRelationId({
    userCode: args.userCode,
    relationId: args.relationId,
  });

  const merged = mergeRows(prevRow, nextRow);

  const { error } = await supabase
    .from('iros_relationship_memory')
    .upsert([merged], {
      onConflict: 'user_code,relation_id',
      ignoreDuplicates: false,
    });

  if (error) {
    console.error('[IROS/REL_MEMORY][UPSERT_ERROR]', error);
  } else {
    console.log('[IROS/REL_MEMORY][UPSERT_OK]', {
      userCode: args.userCode,
      relationId: args.relationId,
    });
  }
}
