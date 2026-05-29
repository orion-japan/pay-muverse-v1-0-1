// src/lib/iros/relationship/relationshipTypes.ts
// iros — Relationship Layer v1.0 (types)
// 恋愛・人間関係専用のメタ定義

// ====================== 基本状態 ======================

export type RelationFocus =
  | 'approaching'
  | 'stable'
  | 'distancing'
  | 'uncertain'
  | 'broken';

export type DistanceLevel = 'low' | 'mid' | 'high';

export type CertaintyLevel = 'low' | 'mid' | 'high';

export type PowerBalance =
  | 'balanced'
  | 'user_dominant'
  | 'other_dominant';

export type InteractionStage =
  | 'initial'
  | 'building'
  | 'deepening'
  | 'unstable'
  | 'detaching';

// ====================== 感情・反応 ======================

export type AttachmentHint =
  | 'pursue'
  | 'avoid'
  | 'anxious'
  | 'secure'
  | 'unknown';

export type EmotionalTemperature =
  | 'low'
  | 'mid'
  | 'high'
  | 'volatile';

export type ProjectionFlag =
  | 'self_doubt'
  | 'mind_reading'
  | 'catastrophizing'
  | 'idealization'
  | 'generalization';

// ====================== 行動モード ======================

export type RelationshipAdviceMode =
  | 'calm'
  | 'delay_action'
  | 'open_softly'
  | 'clarify'
  | 'repair'
  | 'distance';

// ====================== Relationship Memory ======================

export type RelationshipMemory = {
  relationId: string;

  displayName?: string | null;
  role?: string | null;

  facts?: string[];
  patterns?: string[];

  safeOpeners?: string[];
  pressureTriggers?: string[];

  userReactionPattern?: string[];

  unresolvedTopics?: string[];

  confidence?: number | null;
};

// ====================== Writer用パケット ======================

export type RelationshipPacket = {
  STATE: {
    e_now?: string | null;
    depth_now?: string | null;
    emotional_temperature?: EmotionalTemperature | null;
  };

  RELATION: {
    domain?: RelationDomain | null;
    role?: RelationRole | null;
    structure?: RelationStructure | null;

    distance?: DistanceLevel | null;
    certainty?: CertaintyLevel | null;
    power_balance?: PowerBalance | null;
  };

  REACTION: {
    attachment?: AttachmentHint | null;
    projection_flag?: ProjectionFlag | null;
    impulse?: string | null;
  };

  GOAL?: 'repair' | 'clarify' | 'reconnect' | 'distance' | 'self_settle';

  CONSTRAINTS?: {
    avoid_pressure?: boolean;
    avoid_repeated_questions?: boolean;
  };
};

export type RelationDomain = 'romance' | 'business' | 'client' | 'customer' | 'collaboration' | 'team' | 'organization' | 'family' | 'relative' | 'friendship' | 'mentor' | 'student' | 'community' | 'neighbor' | 'public' | 'neutral_person' | 'unknown';

export type RelationRole = 'romantic_person' | 'partner' | 'client' | 'customer' | 'vendor' | 'coworker' | 'boss' | 'subordinate' | 'collaborator' | 'research_partner' | 'family' | 'relative' | 'parent' | 'child' | 'sibling' | 'spouse' | 'friend' | 'mentor' | 'student' | 'teacher' | 'community_member' | 'neighbor' | 'public_person' | 'unknown_person';

export type RelationStructure = 'emotional_bond' | 'agreement_gap' | 'role_gap' | 'responsibility_gap' | 'progress_gap' | 'authority_gap' | 'boundary_gap' | 'trust_gap' | 'communication_gap' | 'expectation_gap' | 'care_gap' | 'inheritance_gap' | 'community_gap' | 'unknown';
