export type MemoryIntent =
  | 'screenshot_diagnosis_recall'
  | 'ir_diagnosis_recall'
  | 'diagnosis_followup'
  | 'relationship_recall'
  | 'relationship_followup'
  | 'person_state_recall'
  | 'person_reference'
  | 'nickname_reference'
  | 'project_context_recall'
  | 'working_rule_recall'
  | 'past_context_recall'
  | 'pending_offer_followup'
  | 'active_thread_followup'
  | 'current_state_recall'
  | 'normal_chat'
  | 'unknown';

export type MemorySpace =
  | 'screenshot_diagnosis'
  | 'ir_diagnosis'
  | 'relationship'
  | 'person'
  | 'project'
  | 'development'
  | 'creative'
  | 'long_term'
  | 'state'
  | 'past_context'
  | 'active_thread'
  | 'pending_offer'
  | 'normal'
  | 'unknown';

export type SourceAuthority =
  | 'screenshot_diagnosis_text'
  | 'ir_diagnosis_text'
  | 'relationship_memory'
  | 'person_intent_state'
  | 'project_context_memory'
  | 'working_rule_memory'
  | 'long_term_memory'
  | 'pending_offer'
  | 'active_context_thread'
  | 'conversation_continuity_seed'
  | 'memory_state'
  | 'past_context_note'
  | 'user_text'
  | 'none';

export type UniversalPreSeedRoute =
  | 'diagnosis_writer'
  | 'relationship_writer'
  | 'person_writer'
  | 'project_writer'
  | 'memory_writer'
  | 'normal_writer'
  | 'hql_creation_landing'
  | 'direct_reply'
  | 'clarify'
  | 'blocked';

export type ResolvedTarget = {
  status: 'resolved' | 'ambiguous' | 'not_found';
  label: string | null;
  targetKey: string | null;
  canonicalName: string | null;
  aliases: string[];
  nicknameMatched: string | null;
  domain:
    | 'diagnosis'
    | 'relationship'
    | 'person'
    | 'project'
    | 'development'
    | 'creative'
    | 'general'
    | 'unknown';
  confidence: number;
  source:
    | 'explicit_user_text'
    | 'nickname_memory'
    | 'active_thread'
    | 'pending_offer'
    | 'relationship_memory'
    | 'person_intent_state'
    | 'history'
    | 'none';
};

export type ResolvedRelation = {
  status: 'resolved' | 'ambiguous' | 'not_found';
  relationId: string | null;
  displayName: string | null;
  selfLabel: string | null;
  otherLabel: string | null;
  targetKey: string | null;
  relationRole:
    | 'lover'
    | 'friend'
    | 'family'
    | 'client'
    | 'teacher'
    | 'student'
    | 'partner'
    | 'coworker'
    | 'unknown';
  confidence: number;
  source:
    | 'relationship_memory'
    | 'active_thread'
    | 'explicit_user_text'
    | 'history'
    | 'none';
};

export type MemoryGraphNode = {
  nodeId: string;
  kind:
    | 'person'
    | 'nickname'
    | 'relationship'
    | 'diagnosis'
    | 'project'
    | 'working_rule'
    | 'long_term_fact'
    | 'active_thread'
    | 'pending_offer';
  label: string;
  targetKey: string | null;
  relationId: string | null;
  confidence: number;
  sourceTable: string | null;
  sourceId: string | number | null;
};

export type MemoryGraphEdge = {
  fromNodeId: string;
  toNodeId: string;
  relation:
    | 'alias_of'
    | 'diagnosis_of'
    | 'relationship_with'
    | 'state_of'
    | 'project_about'
    | 'mentioned_in'
    | 'continues_from'
    | 'derived_from'
    | 'conflicts_with'
    | 'same_target_as';
  confidence: number;
  createdAt: string;
  expiresAfterTurns?: number | null;
};

export type UniversalWriterInput = {
  writerKind:
    | 'diagnosis_writer'
    | 'relationship_writer'
    | 'person_writer'
    | 'project_writer'
    | 'memory_writer'
    | 'normal_writer';

  userText: string;

  sourceAuthority: SourceAuthority;
  sourceText: string | null;
  seedText: string;

  resolvedTarget: ResolvedTarget | null;
  resolvedRelation: ResolvedRelation | null;

  memorySpace: MemorySpace;
  memoryIntent: MemoryIntent;

  systemText: string;
  userPrompt: string;

  constraints: {
    mustUseSourceText: boolean;
    mustUseConcreteTerms: number;
    doNotAskUserToRepeat: boolean;
    doNotInventMemory: boolean;
    doNotUseOtherTargets: boolean;
    questionsMax: number;
  };
};

export type UniversalPreSeedDecision = {
  kind:
    | 'screenshot_diagnosis_boot'
    | 'screenshot_diagnosis_followup'
    | 'ir_diagnosis_recall'
    | 'ir_diagnosis_followup'
    | 'relationship_recall'
    | 'relationship_followup'
    | 'person_state_recall'
    | 'person_reference'
    | 'nickname_reference'
    | 'project_context_recall'
    | 'working_rule_recall'
    | 'pending_offer_followup'
    | 'active_thread_followup'
    | 'memory_recall'
    | 'hql_creation_landing'
    | 'normal_chat'
    | 'ambiguous'
    | 'blocked';

  memoryIntent: MemoryIntent;
  memorySpace: MemorySpace;
  route: UniversalPreSeedRoute;

  confidence: number;

  resolvedTarget: ResolvedTarget | null;
  resolvedRelation: ResolvedRelation | null;

  sourceAuthority: SourceAuthority;
  sourceKind: string | null;
  sourceId: string | number | null;
  sourceText: string | null;

  memoryGraph?: {
    nodes: MemoryGraphNode[];
    edges: MemoryGraphEdge[];
  };

  seedText: string | null;
  writerInput: UniversalWriterInput | null;

  directReply: string | null;

  shouldUsePreSeedWriter: boolean;
  shouldBypassNormalWriter: boolean;
  shouldBypassRephrase: boolean;
  shouldSuppressHistoryForWriter: boolean;
  shouldSuppressSimilarFlow: boolean;
  shouldSuppressSlotPlan: boolean;
  shouldSuppressMemoryDelta: boolean;
  shouldSuppressNormalResonance: boolean;

  shouldOpenContextThread: boolean;
  contextThreadCode: string | null;

  ctxPackPatch: Record<string, any>;
  metaPatch: Record<string, any>;

  debug: {
    reason: string;
    matchedPattern: string | null;
    extractedId?: string | number | null;
    targetKey?: string | null;
    relationId?: string | null;
    routeReason?: string | null;
  };
};
