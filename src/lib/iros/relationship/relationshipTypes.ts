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
