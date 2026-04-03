// src/lib/iros/relationship/resolveRelation.ts
// iros — Relationship Layer v1.0 (resolver)
// 会話文から対象関係（self×他者 / 他者×他者）を解決する

import type { RelationshipMemory } from './relationshipTypes';

export type RelationshipEntity = {
  relationId: string;
  displayName?: string | null;
  aliases?: string[] | null;
  role?: string | null;
};

export type ResolveRelationArgs = {
  userText: string;
  topicDigest?: string | null;
  historyText?: string | null;

  candidates?: RelationshipEntity[] | null;

  lastRelationId?: string | null;
  selfId?: string | null;
};

export type ResolvedRelation = {
  relationId: string | null;

  mode: 'self_other' | 'between_others' | 'fallback' | 'unresolved';

  matchedEntityIds: string[];
  matchedNames: string[];

  primaryEntityId: string | null;
  secondaryEntityId: string | null;

  reason: string;
};

function normalizeLite(value: unknown): string {
  return String(value ?? '').trim();
}

function lowerLite(value: unknown): string {
  return normalizeLite(value).toLowerCase();
}

function uniq(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)));
}

function includesLoose(base: string, token: string): boolean {
  if (!base || !token) return false;
  return base.includes(token) || token.includes(base);
}

function normalizeNameToken(value: unknown): string {
  return lowerLite(value).replace(/\s+/g, '');
}

function buildMergedText(args: ResolveRelationArgs): string {
  return lowerLite(
    [args.userText, args.topicDigest, args.historyText]
      .filter(Boolean)
      .join(' '),
  );
}

function collectEntityTokens(entity: RelationshipEntity): string[] {
  const out: string[] = [];

  const displayName = normalizeNameToken(entity.displayName);
  if (displayName) out.push(displayName);

  if (Array.isArray(entity.aliases)) {
    for (const alias of entity.aliases) {
      const s = normalizeNameToken(alias);
      if (s) out.push(s);
    }
  }

  const role = normalizeNameToken(entity.role);
  if (role) out.push(role);

  return uniq(out);
}

function scoreEntityHit(text: string, entity: RelationshipEntity): number {
  if (!text) return 0;

  let score = 0;
  const displayName = normalizeNameToken(entity.displayName);
  const role = normalizeNameToken(entity.role);

  if (displayName && includesLoose(text, displayName)) score += 5;
  if (role && includesLoose(text, role)) score += 2;

  if (Array.isArray(entity.aliases)) {
    for (const alias of entity.aliases) {
      const s = normalizeNameToken(alias);
      if (s && includesLoose(text, s)) score += 3;
    }
  }

  return score;
}

function pickMatchedEntities(
  text: string,
  candidates: RelationshipEntity[],
): RelationshipEntity[] {
  const scored = candidates
    .map((entity) => ({
      entity,
      score: scoreEntityHit(text, entity),
      tokenCount: collectEntityTokens(entity).length,
    }))
    .filter((row) => row.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.tokenCount - a.tokenCount;
    });

  const picked: RelationshipEntity[] = [];
  const used = new Set<string>();

  for (const row of scored) {
    if (!row.entity.relationId) continue;
    if (used.has(row.entity.relationId)) continue;
    picked.push(row.entity);
    used.add(row.entity.relationId);
    if (picked.length >= 2) break;
  }

  return picked;
}

function buildPairRelationId(a: string, b: string): string {
  const ids = [a, b].filter(Boolean).sort();
  return ids.join('__');
}

function buildSelfOtherRelationId(selfId: string, otherId: string): string {
  return `${selfId}__${otherId}`;
}

export function resolveRelation(
  args: ResolveRelationArgs,
): ResolvedRelation {
  const text = buildMergedText(args);
  const candidates = Array.isArray(args.candidates) ? args.candidates : [];
  const selfId = normalizeLite(args.selfId) || 'self';
  const lastRelationId = normalizeLite(args.lastRelationId) || null;

  if (!text && lastRelationId) {
    return {
      relationId: lastRelationId,
      mode: 'fallback',
      matchedEntityIds: [],
      matchedNames: [],
      primaryEntityId: null,
      secondaryEntityId: null,
      reason: 'empty_text_fallback',
    };
  }

  const matched = pickMatchedEntities(text, candidates);

  if (matched.length >= 2) {
    const a = matched[0];
    const b = matched[1];

    return {
      relationId: buildPairRelationId(a.relationId, b.relationId),
      mode: 'between_others',
      matchedEntityIds: [a.relationId, b.relationId],
      matchedNames: uniq([
        normalizeLite(a.displayName),
        normalizeLite(b.displayName),
      ]),
      primaryEntityId: a.relationId,
      secondaryEntityId: b.relationId,
      reason: 'matched_two_entities',
    };
  }

  if (matched.length === 1) {
    const other = matched[0];

    return {
      relationId: buildSelfOtherRelationId(selfId, other.relationId),
      mode: 'self_other',
      matchedEntityIds: [other.relationId],
      matchedNames: uniq([normalizeLite(other.displayName)]),
      primaryEntityId: other.relationId,
      secondaryEntityId: null,
      reason: 'matched_one_entity',
    };
  }

  if (lastRelationId) {
    return {
      relationId: lastRelationId,
      mode: 'fallback',
      matchedEntityIds: [],
      matchedNames: [],
      primaryEntityId: null,
      secondaryEntityId: null,
      reason: 'fallback_last_relation',
    };
  }

  return {
    relationId: null,
    mode: 'unresolved',
    matchedEntityIds: [],
    matchedNames: [],
    primaryEntityId: null,
    secondaryEntityId: null,
    reason: 'no_match',
  };
}

// 将来の relationship memory 保存時に使いやすい変換ヘルパ
export function toRelationshipEntity(
  memory: RelationshipMemory,
  aliases?: string[] | null,
): RelationshipEntity {
  return {
    relationId: memory.relationId,
    displayName: memory.displayName ?? null,
    aliases: Array.isArray(aliases) ? aliases : null,
    role: memory.role ?? null,
  };
}
