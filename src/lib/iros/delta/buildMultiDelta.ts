import type {
  BuildDeltaInput,
  MultiDelta,
  EnergyShift,
  IntentShift,
  StructureShift,
  LayerShift,
} from './types';

function norm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function buildEnergyShift(input: BuildDeltaInput): EnergyShift | null {
  const from = norm(input.prev.e_turn);
  const to = norm(input.now.e_turn);
  return {
    from,
    to,
    changed: from !== to,
  };
}

function buildIntentShift(input: BuildDeltaInput): IntentShift | null {
  const from = norm(input.prev.intent);
  const to = norm(input.now.intent);
  return {
    from,
    to,
    changed: from !== to,
  };
}

function buildStructureShift(input: BuildDeltaInput): StructureShift | null {
  const prevTopic = norm(input.prev.topic);
  const nextTopic = norm(input.now.topic);
  return {
    topicChanged: prevTopic !== nextTopic,
    prevTopic,
    nextTopic,
  };
}

function buildLayerShift(input: BuildDeltaInput): LayerShift | null {
  const from = input.prev.layer ?? null;
  const to = input.now.layer ?? null;
  return {
    from,
    to,
    changed: from !== to,
  };
}

export function buildMultiDelta(input: BuildDeltaInput): MultiDelta {
  return {
    energyShift: buildEnergyShift(input),
    intentShift: buildIntentShift(input),
    structureShift: buildStructureShift(input),
    layerShift: buildLayerShift(input),
  };
}
