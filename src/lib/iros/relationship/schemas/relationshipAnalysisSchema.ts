import type {
  RelationshipFact,
  RelationshipMemoryRow,
  RelationshipPattern,
} from '@/lib/iros/memory/relationshipMemory.types';

export type RelationshipAnalysisDomain = 'romance' | 'relationship' | 'compatibility';

export type RelationshipAnalysisPairType =
  | 'person_person'
  | 'type_type'
  | 'star_sign'
  | 'kyusei'
  | 'other';
export type RelationshipAnalysisTrait = {
  coreDrive: string;
  movement: string;
  sensitivity: string;
  strength: string;
};

export type RelationshipAnalysisFriction = {
  clashPoint: string;
  misreadAtoB: string;
  misreadBtoA: string;
  hiddenCause: string;
};

export type RelationshipAnalysisTranslation = {
  seenAtoB: string;
  seenBtoA: string;
  intentA: string;
  intentB: string;
  translationKey: string;
};

export type RelationshipAnalysisReinterpretation = {
  reframeAtoB: string;
  reframeBtoA: string;
  bridgeKey: string;
};

export type RelationshipAnalysisRoleFit = {
  roleA: string;
  roleB: string;
  synergy: string;
};


export type RelationshipMemoryDerived = {
  pressureTriggers?: string[];
  reactionPatterns?: string[];
  unresolvedTopics?: string[];
  safeOpeners?: string[];
  relationFacts?: string[];
  relationPatterns?: string[];
};

export type RelationshipAnalysis = {
  domain: RelationshipAnalysisDomain;
  pairType: RelationshipAnalysisPairType;

  memoryUsed: boolean;
  memoryConfidence: number | null;
  memorySummary: string[] | null;

  coreTension: string;
  openingFrame: string;

  traitA: RelationshipAnalysisTrait;
  traitB: RelationshipAnalysisTrait;

  friction: RelationshipAnalysisFriction;
  translation: RelationshipAnalysisTranslation;
  reinterpretation: RelationshipAnalysisReinterpretation;
  roleFit: RelationshipAnalysisRoleFit;

  essenceClose: string;

  memoryDerived?: RelationshipMemoryDerived;
};

export type RelationshipAnalysisInput = {
  userText: string;
  pairText?: string | null;

  domain?: RelationshipAnalysisDomain | null;
  pairType?: RelationshipAnalysisPairType | null;

  relationshipMemory?: RelationshipMemoryRow | null;

  flow?: {
    delta?: string | null;
    currentStage?: string | null;
    observedStage?: string | null;
    qCode?: string | null;
    emotionalTemperature?: string | null;
    continuityKind?: string | null;
    relationFocus?: string | null;
    mirrorFlowV1?: unknown | null;
  } | null;
};

export function toMemoryDerived(
  relationshipMemory: RelationshipMemoryRow | null | undefined
): RelationshipMemoryDerived | undefined {
  if (!relationshipMemory) return undefined;

  const facts = Array.isArray(relationshipMemory.facts)
    ? relationshipMemory.facts
        .map((fact: RelationshipFact) => {
          const key = String(fact?.key ?? '').trim();
          const value = String(fact?.value ?? '').trim();
          if (!key && !value) return null;
          if (key && value) return `${key}: ${value}`;
          return key || value;
        })
        .filter((value): value is string => Boolean(value))
    : [];

  const patterns = Array.isArray(relationshipMemory.patterns)
    ? relationshipMemory.patterns
        .map((pattern: RelationshipPattern) => {
          const key = String(pattern?.key ?? '').trim();
          const note = String(pattern?.note ?? '').trim();
          if (!key && !note) return null;
          if (key && note) return `${key}: ${note}`;
          return key || note;
        })
        .filter((value): value is string => Boolean(value))
    : [];

  const pressureTriggers = Array.isArray(relationshipMemory.pressure_triggers)
    ? relationshipMemory.pressure_triggers.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];

  const reactionPatterns = Array.isArray(relationshipMemory.user_reaction_pattern)
    ? relationshipMemory.user_reaction_pattern.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];

  const unresolvedTopics = Array.isArray(relationshipMemory.unresolved_topics)
    ? relationshipMemory.unresolved_topics.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];

  const safeOpeners = Array.isArray(relationshipMemory.safe_openers)
    ? relationshipMemory.safe_openers.filter(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      )
    : [];

  return {
    pressureTriggers: pressureTriggers.length > 0 ? pressureTriggers : undefined,
    reactionPatterns: reactionPatterns.length > 0 ? reactionPatterns : undefined,
    unresolvedTopics: unresolvedTopics.length > 0 ? unresolvedTopics : undefined,
    safeOpeners: safeOpeners.length > 0 ? safeOpeners : undefined,
    relationFacts: facts.length > 0 ? facts : undefined,
    relationPatterns: patterns.length > 0 ? patterns : undefined,
  };
}
