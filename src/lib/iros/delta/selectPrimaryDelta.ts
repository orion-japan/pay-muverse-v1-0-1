import type {
  MultiDelta,
  DeltaPolicy,
  PrimaryDelta,
  PrimaryDeltaType,
} from './types';

function pickByHint(
  deltas: MultiDelta,
  hint?: PrimaryDeltaType,
): PrimaryDelta | null {
  if (!hint) return null;

  if (hint === 'energy' && deltas.energyShift?.changed) {
    return { type: 'energy', payload: deltas.energyShift };
  }

  if (hint === 'intent' && deltas.intentShift?.changed) {
    return { type: 'intent', payload: deltas.intentShift };
  }

  if (hint === 'structure' && deltas.structureShift?.topicChanged) {
    return { type: 'structure', payload: deltas.structureShift };
  }

  return null;
}

export function selectPrimaryDelta(
  deltas: MultiDelta,
  policy: DeltaPolicy,
): PrimaryDelta | null {
  const hinted = pickByHint(deltas, policy.primaryHint);
  if (hinted) return hinted;

  if (policy.layer === 'intent') {
    if (deltas.intentShift?.changed) {
      return { type: 'intent', payload: deltas.intentShift };
    }
    if (deltas.energyShift?.changed) {
      return { type: 'energy', payload: deltas.energyShift };
    }
    if (deltas.structureShift?.topicChanged) {
      return { type: 'structure', payload: deltas.structureShift };
    }
    return null;
  }

  if (policy.layer === 'creation') {
    if (deltas.structureShift?.topicChanged) {
      return { type: 'structure', payload: deltas.structureShift };
    }
    if (deltas.intentShift?.changed) {
      return { type: 'intent', payload: deltas.intentShift };
    }
    if (deltas.energyShift?.changed) {
      return { type: 'energy', payload: deltas.energyShift };
    }
    return null;
  }

  if (deltas.structureShift?.topicChanged) {
    return { type: 'structure', payload: deltas.structureShift };
  }
  if (deltas.energyShift?.changed) {
    return { type: 'energy', payload: deltas.energyShift };
  }
  if (deltas.intentShift?.changed) {
    return { type: 'intent', payload: deltas.intentShift };
  }

  return null;
}
