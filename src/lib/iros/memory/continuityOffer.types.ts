export type ContinuityOfferDomain =
  | 'diagnosis'
  | 'relationship'
  | 'person'
  | 'project'
  | 'development'
  | 'creative'
  | 'general'
  | 'unknown';

export type PendingOfferKind =
  | 'choice'
  | 'suggestion'
  | 'next_action'
  | 'analysis_menu';

export type PendingOfferOption = {
  index: number;
  label: string;
  aliases: string[];

  action: string;
  sourceText: string;

  targetLabel: string | null;
  targetKey: string | null;
  domain: ContinuityOfferDomain;

  expectedUserPhrases: string[];
};

export type PendingOffer = {
  offerId: string;
  kind: PendingOfferKind;
  createdAt: string;
  expiresAfterTurns: number;

  source: {
    assistantMessageId: string | null;
    assistantTextHead: string | null;
  };

  subject: {
    label: string | null;
    targetKey: string | null;
    domain: ContinuityOfferDomain;
  };

  options: PendingOfferOption[];

  acceptPhrases: string[];

  guard: {
    currentTurnOnly: boolean;
    allowLongTermSave: false;
    allowPastStateMerge: false;
    confidence: number;
  };
};

export type ResolvedOfferSelectedType =
  | 'accept'
  | 'option'
  | 'reject'
  | 'unclear';

export type ResolvedOfferStatus =
  | 'resolved'
  | 'not_resolved'
  | 'expired'
  | 'not_found';

export type ResolvedOffer = {
  status: ResolvedOfferStatus;

  offerId: string | null;

  selected: {
    type: ResolvedOfferSelectedType;
    label: string | null;
    optionIndex: number | null;
    phrase: string;
  };

  action: string | null;

  targetLabel: string | null;
  targetKey: string | null;
  domain: ContinuityOfferDomain | null;

  source: {
    pendingOfferFound: boolean;
    matchedBy:
      | 'exact_alias'
      | 'accept_phrase'
      | 'semantic_short_reply'
      | 'none';
    confidence: number;
  };
};

export type ContinuitySeedStatus =
  | 'FOUND'
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'NOT_REQUESTED';

export type OfferContinuityControl = {
  status: ContinuitySeedStatus;
  continuityKind: 'offer_followup' | null;

  selectedLabel: string | null;
  selectedAction: string | null;

  targetLabel: string | null;
  targetKey: string | null;
  domain: ContinuityOfferDomain | null;

  source: 'pendingOffer' | 'none';

  rule: string;
};

export type DiagnosisContextControl = {
  status: 'FOUND' | 'NOT_FOUND' | 'NOT_REQUESTED';

  source:
    | 'iros_ir_diagnosis_results'
    | 'iros_memory_state'
    | 'iros_messages.irMeta'
    | 'none';

  targetLabel: string | null;
  targetKey: string | null;

  diagnosisText: string | null;
  qPrimary: string | null;
  depthStage: string | null;
  phase: string | null;
  createdAt: string | null;

  rule: string;
};

export type TargetContextControl = {
  targetLabel: string | null;
  targetKey: string | null;
  domain: ContinuityOfferDomain | null;

  source:
    | 'pendingOffer'
    | 'diagnosis'
    | 'relationship'
    | 'reference'
    | 'userText'
    | 'none';

  confidence: number;

  guard: string;
};

export type ContinuitySeed = {
  offer: OfferContinuityControl;
  diagnosis: DiagnosisContextControl;
  target: TargetContextControl;

  writerContract: {
    seedIsPrimary: true;
    forbidUserTextDeepening: boolean;
    forbidFakeDiagnosisReference: boolean;
    forbidUnresolvedChoice: boolean;
    rule: string;
  };
};
