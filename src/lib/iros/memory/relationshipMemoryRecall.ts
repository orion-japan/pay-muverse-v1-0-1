// src/lib/iros/memory/relationshipMemoryRecall.ts
// iros — Relationship Memory recall v1
// 役割：DBから関係メモリーを読み出し、writer注入用の noteText を作る

import { createClient } from '@supabase/supabase-js';
import type {
  RelationshipMemoryRecallQuery,
  RelationshipMemoryRow,
} from './relationshipMemory.types';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function norm(value: unknown): string {
  return String(value ?? '').trim();
}

function lower(value: unknown): string {
  return norm(value).toLowerCase();
}

function includesLoose(base: string, candidate: string): boolean {
  if (!base || !candidate) return false;
  return base.includes(candidate) || candidate.includes(base);
}

function pickBestByName(
  rows: RelationshipMemoryRow[],
  displayName: string,
): RelationshipMemoryRow[] {
  const q = lower(displayName);
  if (!q) return rows;

  const exact: RelationshipMemoryRow[] = [];
  const aliasHit: RelationshipMemoryRow[] = [];
  const partial: RelationshipMemoryRow[] = [];

  for (const row of rows) {
    const dn = lower(row.display_name);
    const aliases = Array.isArray(row.aliases) ? row.aliases.map(lower) : [];

    if (dn && dn === q) {
      exact.push(row);
      continue;
    }

    if (aliases.some((a) => a === q)) {
      aliasHit.push(row);
      continue;
    }

    if (
      (dn && includesLoose(dn, q)) ||
      aliases.some((a) => includesLoose(a, q))
    ) {
      partial.push(row);
    }
  }

  return [...exact, ...aliasHit, ...partial];
}

function pickBestByRole(
  rows: RelationshipMemoryRow[],
  role: string,
): RelationshipMemoryRow[] {
  const q = lower(role);
  if (!q) return rows;

  const exact = rows.filter((row) => lower(row.role) === q);
  if (exact.length > 0) return exact;

  return rows.filter((row) => includesLoose(lower(row.role), q));
}

function pickBestByTopic(
  rows: RelationshipMemoryRow[],
  topic: string,
): RelationshipMemoryRow[] {
  const q = lower(topic);
  if (!q) return rows;

  return rows.filter((row) => {
    const unresolved = Array.isArray(row.unresolved_topics)
      ? row.unresolved_topics.map(lower)
      : [];

    const facts = Array.isArray(row.facts)
      ? row.facts.map((f) => `${lower(f?.key)} ${lower(f?.value)}`)
      : [];

    const patterns = Array.isArray(row.patterns)
      ? row.patterns.map((p) => `${lower(p?.key)} ${lower(p?.note)}`)
      : [];

    return (
      unresolved.some((v) => includesLoose(v, q)) ||
      facts.some((v) => includesLoose(v, q)) ||
      patterns.some((v) => includesLoose(v, q))
    );
  });
}

export async function loadRelationshipMemoriesForTurn(
  args: RelationshipMemoryRecallQuery,
): Promise<RelationshipMemoryRow[]> {
  const {
    userCode,
    relationId,
    displayName,
    role,
    topic,
    limit = 8,
  } = args;

  let query = supabase
    .from('iros_relationship_memory')
    .select('*')
    .eq('user_code', userCode)
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (norm(relationId)) {
    query = query.eq('relation_id', norm(relationId));
  }

  const { data, error } = await query;

  if (error) {
    console.error('[IROS/REL_MEMORY][RECALL_ERROR]', error);
    return [];
  }

  let rows = (data ?? []) as RelationshipMemoryRow[];

  if (norm(displayName)) {
    rows = pickBestByName(rows, norm(displayName));
  }

  if (norm(role)) {
    rows = pickBestByRole(rows, norm(role));
  }

  if (norm(topic)) {
    rows = pickBestByTopic(rows, norm(topic));
  }

  return rows.slice(0, Math.max(1, limit));
}

export function buildRelationshipMemoryNoteText(args: {
  rows: RelationshipMemoryRow[];
  maxItems?: number;
}): {
  noteText: string;
  picked: RelationshipMemoryRow[];
} {
  const { rows, maxItems = 3 } = args;

  if (!rows.length) {
    return {
      noteText: '',
      picked: [],
    };
  }

  const picked = rows.slice(0, Math.max(1, maxItems));

  const body = picked
    .map((row) => {
      const lines: string[] = [];

      const title = [
        row.display_name ? `name=${row.display_name}` : null,
        row.role ? `role=${row.role}` : null,
        row.relation_id ? `relationId=${row.relation_id}` : null,
      ]
        .filter(Boolean)
        .join(' / ');

      if (title) lines.push(`- ${title}`);

      if (Array.isArray(row.unresolved_topics) && row.unresolved_topics.length > 0) {
        lines.push(`  unresolved: ${row.unresolved_topics.join(' / ')}`);
      }

      if (Array.isArray(row.user_reaction_pattern) && row.user_reaction_pattern.length > 0) {
        lines.push(`  reaction: ${row.user_reaction_pattern.join(' / ')}`);
      }

      if (Array.isArray(row.safe_openers) && row.safe_openers.length > 0) {
        lines.push(`  safe_openers: ${row.safe_openers.join(' / ')}`);
      }

      if (Array.isArray(row.pressure_triggers) && row.pressure_triggers.length > 0) {
        lines.push(`  pressure_triggers: ${row.pressure_triggers.join(' / ')}`);
      }

      if (Array.isArray(row.facts) && row.facts.length > 0) {
        const facts = row.facts
          .map((f) => `${norm(f?.key)}=${norm(f?.value)}`)
          .filter(Boolean)
          .join(' / ');
        if (facts) lines.push(`  facts: ${facts}`);
      }

      if (Array.isArray(row.patterns) && row.patterns.length > 0) {
        const patterns = row.patterns
          .map((p) => {
            const k = norm(p?.key);
            const n = norm(p?.note);
            if (k && n) return `${k}:${n}`;
            return k || n;
          })
          .filter(Boolean)
          .join(' / ');
        if (patterns) lines.push(`  patterns: ${patterns}`);
      }

      return lines.join('\n');
    })
    .filter(Boolean)
    .join('\n');

  const noteText =
    '【RELATIONSHIP_MEMORY / DO NOT OUTPUT】\n' +
    body;

  return {
    noteText,
    picked,
  };
}
