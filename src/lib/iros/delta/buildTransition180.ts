import {
  listFlow180,
  buildFlowDelta,
  type FlowStateId,
  type FlowDelta,
} from '@/lib/iros/flow/flow180';

export function buildTransition180Candidates(
  prev: FlowStateId | null,
): FlowDelta[] {
  const all = listFlow180();

  return all.map((entry) => {
    return buildFlowDelta(prev, entry.id);
  });
}
