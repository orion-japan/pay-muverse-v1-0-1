// src/lib/iros/memory/relationshipMemory.types.ts
// iros — Relationship Memory v1 types

export type RelationshipRole =
  | 'romantic_interest'
  | 'partner'
  | 'ex_partner'
  | 'spouse'
  | 'friend'
  | 'family'
  | 'coworker'
  | 'boss'
  | 'subordinate'
  | 'client'
  | 'other';

export type RelationshipFact = {
  key: string;
  value: string;
  updatedAt?: string | null;
};

export type RelationshipPattern = {
  key: string;
  note?: string | null;
  confidence?: number | null;
};

export type RelationshipMemoryRow = {
  id?: string;

  user_code: string;
  relation_id: string;

  display_name: string | null;
  aliases: string[] | null;
  role: RelationshipRole | string | null;

  facts: RelationshipFact[] | null;
  patterns: RelationshipPattern[] | null;

  safe_openers: string[] | null;
  pressure_triggers: string[] | null;
  user_reaction_pattern: string[] | null;
  unresolved_topics: string[] | null;

  confidence: number | null;

  created_at?: string | null;
  updated_at?: string | null;
};

export type UpsertRelationshipMemoryInput = {
  userCode: string;
  relationId: string;

  displayName?: string | null;
  aliases?: string[] | null;
  role?: RelationshipRole | string | null;

  facts?: RelationshipFact[] | null;
  patterns?: RelationshipPattern[] | null;

  safeOpeners?: string[] | null;
  pressureTriggers?: string[] | null;
  userReactionPattern?: string[] | null;
  unresolvedTopics?: string[] | null;

  confidence?: number | null;
};

export type RelationshipMemoryRecallQuery = {
  userCode: string;

  relationId?: string | null;
  displayName?: string | null;
  role?: string | null;
  topic?: string | null;

  limit?: number;
};
