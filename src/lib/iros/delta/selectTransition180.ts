import type { FlowDelta, FlowStateId } from '@/lib/iros/flow/flow180';

export type Transition180Pick = {
  primary: FlowDelta | null;
  secondary: FlowDelta[];
};

function score(delta: FlowDelta, futureStateId?: FlowStateId | null): number {
  let s = 0;

  if (delta.changed) s += 10;

  switch (delta.deltaType) {
    case 'stage_energy':
      s += 6;
      break;
    case 'all_changed':
      s += 5;
      break;
    case 'stage_only':
      s += 4;
      break;
    case 'energy_only':
      s += 3;
      break;
    case 'stage_polarity':
      s += 3;
      break;
    case 'energy_polarity':
      s += 2;
      break;
    case 'polarity_only':
      s += 1;
      break;
    case 'same':
    default:
      s += 0;
      break;
  }

  if (futureStateId && delta.now === futureStateId) {
    s += 100;
  }

  return s;
}

export function selectTransition180(
  candidates: FlowDelta[],
  futureStateId?: FlowStateId | null,
): Transition180Pick {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { primary: null, secondary: [] };
  }

  const ranked = [...candidates].sort(
    (a, b) => score(b, futureStateId) - score(a, futureStateId),
  );

  return {
    primary: ranked[0] ?? null,
    secondary: ranked.slice(1, 6),
  };
}
