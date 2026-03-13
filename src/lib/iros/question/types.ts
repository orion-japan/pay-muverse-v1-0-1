// src/lib/iros/question/types.ts
// IROS QuestionEngine v1
// - based on "IROS ITエンジン 実装仕様書 v1.1"
// - question structure only / no text generation

export type DomainType =
  | 'science'
  | 'philosophy'
  | 'personal'
  | 'practical'
  | 'creative'
  | 'cosmology'
  | 'mixed';

export type QuestionType =
  | 'truth'
  | 'structure'
  | 'cause'
  | 'choice'
  | 'meaning'
  | 'future_design'
  | 'unresolved_release';

export type TMode =
  | 'confirm'
  | 'explore_future'
  | 'compare_models'
  | 'design_probe'
  | 'reobserve_past';

export type QCodeLike = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type ETurnLike = 'e1' | 'e2' | 'e3' | 'e4' | 'e5';

export type HypothesisModel = {
  key: string;
  label: string;
  description?: string | null;
};

export type QuestionContextLike = {
  conversationId?: string | null;
  topicHint?: string | null;
  situationSummary?: string | null;
  [key: string]: unknown;
};

export type QuestionEngineInput = {
  userText: string;
  qCode?: QCodeLike | string | null;
  eTurn?: ETurnLike | string | null;
  signals?: Record<string, unknown> | null;
  context?: QuestionContextLike | null;
  intentLine?: unknown;
  intentTransition?: unknown;
};

export type IFrame = {
  domain: DomainType;
  questionType: QuestionType;
  topic: string;
  hypothesisSpace: HypothesisModel[];
  focusCandidate: string[];
};

export type PastResolveState = {
  detected: boolean;
  cues: string[];
  candidateThemes: string[];
};

export type TState = {
  mode: TMode;
  focus: string | null;
  reason?: string | null;
};

export type OutputPolicy = {
  answerFirst: boolean;
  askBackAllowed: boolean;
  splitFactHypothesis: boolean;
  usePastReframe?: boolean;
  avoidPrematureClosure?: boolean;
};

export type QuestionEngineResult = {
  domain: DomainType;
  questionType: QuestionType;
  iframe: IFrame;
  pastResolve?: PastResolveState | null;
  tState: TState;
  outputPolicy: OutputPolicy;
};

export type DetectDomainInput = Pick<QuestionEngineInput, 'userText' | 'context'>;

export type DetectQuestionTypeInput = Pick<
  QuestionEngineInput,
  'userText' | 'context' | 'qCode' | 'eTurn' | 'signals'
> & {
  domain?: DomainType | null;
};

export type BuildIFrameInput = {
  userText: string;
  domain: DomainType;
  questionType: QuestionType;
};

export type DetectPastResolveInput = Pick<QuestionEngineInput, 'userText' | 'context'>;

export type DetectTModeInput = {
  userText: string;
  questionType: QuestionType;
  pastResolve?: PastResolveState | null;
  iframe?: IFrame | null;
};

export type BuildOutputPolicyInput = {
  questionType: QuestionType;
  tMode: TMode;
  pastResolve?: PastResolveState | null;
};
