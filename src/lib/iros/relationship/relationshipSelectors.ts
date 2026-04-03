// src/lib/iros/relationship/relationshipSelectors.ts
// iros — Relationship Layer v1.0 (selectors)
// writer/rephrase に渡す最小理解パケットを組み立てる

import type { RelationshipAnalysis } from './relationshipAnalysis';
import type { RelationshipContext } from './relationshipContext';
import type {
  EmotionalTemperature,
  RelationshipPacket,
} from './relationshipTypes';

export type BuildRelationshipPacketArgs = {
  eNow?: string | null;
  depthNow?: string | null;
  emotionalTemperature?: EmotionalTemperature | null;

  context?: RelationshipContext | null;
  analysis?: RelationshipAnalysis | null;

  relationshipGoal?: 'repair' | 'clarify' | 'reconnect' | 'distance' | 'self_settle' | null;

  avoidPressure?: boolean;
  avoidRepeatedQuestions?: boolean;
};

function normalizeGoal(
  value: BuildRelationshipPacketArgs['relationshipGoal'],
): RelationshipPacket['GOAL'] | undefined {
  if (
    value === 'repair' ||
    value === 'clarify' ||
    value === 'reconnect' ||
    value === 'distance' ||
    value === 'self_settle'
  ) {
    return value;
  }

  return undefined;
}

export function buildRelationshipPacket(
  args: BuildRelationshipPacketArgs,
): RelationshipPacket {
  return {
    STATE: {
      e_now: args.eNow ?? null,
      depth_now: args.depthNow ?? null,
      emotional_temperature: args.emotionalTemperature ?? null,
    },

    RELATION: {
      distance: args.context?.distance_level ?? null,
      certainty: args.context?.certainty_level ?? null,
      power_balance: args.context?.power_balance ?? null,
    },

    REACTION: {
      attachment: args.analysis?.attachment_hint ?? null,
      projection_flag: args.analysis?.projection_flag ?? null,
      impulse: args.analysis?.impulse_kind ?? null,
    },

    GOAL: normalizeGoal(args.relationshipGoal),

    CONSTRAINTS: {
      avoid_pressure: args.avoidPressure ?? true,
      avoid_repeated_questions: args.avoidRepeatedQuestions ?? true,
    },
  };
}
