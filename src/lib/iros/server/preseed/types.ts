import type { CognitionMap } from '../../cognition/cognitionMap';
import type {
  TcfCDirection,
  TcfUserReaction,
  TcfConvergenceState,
} from '../../tcf/tcfRotation';

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
  | 'mu_canon_concept_writer'
  | 'clarify'
  | 'tool_action'
  | 'blocked';

export type PreSeedTcfStarter = {
  cDirection: TcfCDirection;
  userReaction: TcfUserReaction;
  convergence: TcfConvergenceState;
  currentFocus: string | null;
  nextFocus: string | null;

  createAxis?: 'imaginal_form_create' | 'word_create' | 'action_create' | 'none';
  createMode?: 'image_first_create' | 'word_create' | 'action_create' | null;
  focusDomain?: 'relation_waiting' | 'self_next_position' | 'creative_project' | 'field_setting' | 'unknown_generic' | null;
  writerPatternKey?: string | null;
  avoidActionPlan?: boolean;
};

export type SritcfAxis = 'S' | 'R' | 'I' | 'T' | 'C' | 'F';

export type FlowBand = 'SF' | 'RC' | 'IT';

export type CreateSource =
  | 'S_emotion'
  | 'R_relation'
  | 'I_intention'
  | 'T_insight'
  | 'unknown';

export type CreateIntegrity =
  | 'aligned'
  | 'partially_aligned'
  | 'distorted'
  | 'reactive'
  | 'unknown';

export type PreSeedInputIntent =
  | 'deepen'
  | 'explain_reason'
  | 'clarify'
  | 'correct'
  | 'create'
  | 'ask_action'
  | 'continue'
  | 'unknown';

export type PreSeedFlowDirection =
  | 'continue_observation'
  | 'relate_context'
  | 'name_intention'
  | 'hold_before_create'
  | 'place_create'
  | 'let_flow_continue'
  | 'return_to_input'
  | 'correct_angle'
  | 'converge_to_intention';

export type PreSeedConvergenceMode =
  | 'none'
  | 'toward_intention'
  | 'toward_create'
  | 'toward_small_action'
  | 'toward_flow';

export type PreSeedFlowDirective = {
  source: 'preseed_input_flow';

  inputIntent: PreSeedInputIntent;

  currentAxis: SritcfAxis | null;
  currentBand: FlowBand | null;

  flowDirection: PreSeedFlowDirection;
  convergenceMode: PreSeedConvergenceMode;

  shouldDeepen: boolean;
  shouldLimitDeepening: boolean;
  shouldUseCreate: boolean;
  shouldUseSmallAction: boolean;
  shouldHoldAction: boolean;

  intentionFormed: boolean;
  tInsightReady: boolean;

  intentionConvergence: {
    intentionReached: boolean;
    shouldStopAnalysis: boolean;
    shouldNameCore: boolean;
    shouldPlaceCreate: boolean;
    shouldMoveToSmallAction: boolean;
    shouldLetFlowContinue: boolean;
    answerHiddenQuestion?: boolean;
    shouldLandHiddenQuestion?: boolean;
    shouldNameRefusedFuture?: boolean;
  };

  createReady: boolean;
  createSource: CreateSource;
  createIntegrity: CreateIntegrity;
  createDistortionRisk: 'none' | 'weak' | 'medium' | 'strong';

  distortionReason?:
    | 'fear_based'
    | 'approval_seeking'
    | 'relationship_pressure'
    | 'false_assumption'
    | 'overreading_other'
    | 'self_abandonment'
    | 'premature_action'
    | null;

  createDirective?: {
    mode: 'image_first_create' | 'word_create' | 'action_create' | 'flow_acceptance';
    createObject: 'inner_scene' | 'one_sentence' | 'small_gesture' | 'field_setting' | 'small_action';
    imaginalFormFirst: boolean;
    instruction: string;
    writerMove: string[];
    avoid: string[];
  } | null;

  seedDirection: {
    targetLabel?: string | null;
    targetType?: string | null;
    flowSeed?: string | null;
    writerSeed?: string | null;
    avoidSeed?: string[];
  };

  writerGuidance: {
    mustKeepTarget: boolean;
    mustNotOverDeepen: boolean;
    shouldShiftFromAnalysisToPlacement: boolean;
    shouldOfferSmallCreate: boolean;
    shouldAvoidOtherMindAssertion: boolean;
    shouldAvoidLargeAction: boolean;
    shouldLeaveOpenSpace: boolean;
    shouldUseImaginalForm?: boolean;
    shouldAvoidHomework?: boolean;
    shouldAvoidTooManyOptions?: boolean;
    shouldLandHiddenQuestion?: boolean;
    shouldNameRefusedFuture?: boolean;
    hiddenQuestionLandingKind?: 'ethical_abundance_refusal' | 'intention_refusal' | null;
  };

  evidence: {
    fromUserInput: string[];
    fromFlowMeta: string[];
    fromHistory: string[];
  };
};

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

  cognitionMap?: CognitionMap | null;
  cognitionMapSeedText?: string | null;
  tcfStarter?: PreSeedTcfStarter | null;
  preSeedFlowDirective?: PreSeedFlowDirective | null;

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
    cognitionMapApplied?: boolean;
    cognitionMapRelationCode?: string | null;
    cognitionMapProgress?: string | null;
    cognitionMapTriggerKind?: string | null;
    cognitionMapGapState?: string | null;
    tcfStarterApplied?: boolean;
    tcfStarterDirection?: TcfCDirection | null;
    preSeedFlowDirectiveApplied?: boolean;
    preSeedFlowDirection?: PreSeedFlowDirection | null;
    preSeedConvergenceMode?: PreSeedConvergenceMode | null;
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
