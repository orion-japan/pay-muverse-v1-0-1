export type PreSeedKind =
  | 'normal_chat'
  | 'screenshot_diagnosis_boot'
  | 'screenshot_diagnosis_followup'
  | 'ir_diagnosis_followup'
  | 'active_context_followup'
  | 'relationship_reference'
  | 'person_reference'
  | 'memory_reference'
  | 'previous_turn_reference'
  | 'tool_action'
  | 'meta_question'
  | 'unknown';

export type PreSeedSourceAuthority =
  | 'user_text'
  | 'screenshot_diagnosis_text'
  | 'ir_diagnosis_text'
  | 'active_context_frame'
  | 'context_thread'
  | 'relationship_memory'
  | 'memory_state'
  | 'previous_assistant_message'
  | 'external_document'
  | 'none';

export type PreSeedRoute =
  | 'normal_writer'
  | 'diagnosis_writer'
  | 'preseed_llm_reply'
  | 'direct_reply'
  | 'clarify'
  | 'tool_action'
  | 'blocked';

export type PreSeedDecision = {
  kind: PreSeedKind;
  confidence: number;

  sourceAuthority: PreSeedSourceAuthority;
  sourceKind?: string | null;
  sourceId?: string | number | null;
  sourceText?: string | null;

  route: PreSeedRoute;

  seedText?: string | null;
  directReply?: string | null;

  writerInput?: Record<string, any> | null;

  shouldBypassWriter: boolean;
  shouldBypassRephrase: boolean;

  shouldUsePreSeedWriter?: boolean;

  shouldSuppressHistoryForWriter: boolean;
  shouldSuppressSimilarFlow: boolean;
  shouldSuppressSlotPlan: boolean;
  shouldSuppressMemoryDelta: boolean;
  shouldSuppressIntuitionCandidate: boolean;
  shouldSuppressNormalResonance: boolean;

  shouldOpenContextThread: boolean;
  contextThreadCode?: string | null;

  ctxPackPatch: Record<string, any>;
  metaPatch: Record<string, any>;

  debug?: {
    reason?: string;
    matchedPattern?: string | null;
    extractedId?: string | number | null;
    sourceTextHead?: string | null;
    seedHead?: string | null;
    directReplyHead?: string | null;
  };
};

export type ResolvePreSeedDecisionArgs = {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  supabase?: any;
  meta?: any;
  historyForTurn?: any[];
  traceId?: string | null;
};


