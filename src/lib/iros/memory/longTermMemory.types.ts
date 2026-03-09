// src/lib/iros/memory/longTermMemory.types.ts
// iros — Long Term Memory v1 types

export type LongTermMemoryType =
  | 'working_rule'
  | 'preference'
  | 'project_context'
  | 'durable_fact'
  | 'episodic_event';

export type LongTermMemoryStatus =
  | 'active'
  | 'archived'
  | 'deleted';

export type LongTermMemorySource =
  | 'auto'
  | 'manual'
  | 'imported';

export type LongTermMemoryEvidence = {
  conversationId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  reason?: string | null;
  excerpt?: string | null;
  extractedFrom?: 'user' | 'assistant' | 'system' | null;
};

export type LongTermMemoryRow = {
  id: string;

  user_code: string;

  memory_type: LongTermMemoryType;

  key: string;

  value_text: string;

  priority: number | null;

  confidence: number | string | null;

  status: 'active' | 'archived';

  source: string | null;

  // ✅ 追加（意味クラスタ）
  cluster_key?: string | null;

  created_at?: string | null;

  updated_at?: string | null;
};

export type LongTermMemoryCandidate = {
  memoryType: LongTermMemoryType;
  key: string;
  valueText: string;
  normalizedText?: string | null;
  clusterKey?: string | null;
  priority?: number;
  confidence?: number;
  source?: LongTermMemorySource;
  evidence?: LongTermMemoryEvidence;
};

export type ExtractDurableMemoriesArgs = {
  userText: string;
  assistantText?: string | null;
  conversationId?: string | null;
  traceId?: string | null;
};

export type LoadLongTermMemoriesArgs = {
  userCode: string;
  limit?: number;
  types?: LongTermMemoryType[];
};

export type BuildLongTermMemoryNoteArgs = {
  rows: LongTermMemoryRow[];
  maxItems?: number;
};

export type BuildLongTermMemoryNoteResult = {
  noteText: string;
  picked: LongTermMemoryRow[];
};
