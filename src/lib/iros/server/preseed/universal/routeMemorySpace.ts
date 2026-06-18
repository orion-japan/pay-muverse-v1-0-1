import type { MemoryIntent, MemorySpace, ResolvedRelation, ResolvedTarget } from './types';

export function routeMemorySpace(args: {
  memoryIntent: MemoryIntent;
  resolvedTarget?: ResolvedTarget | null;
  resolvedRelation?: ResolvedRelation | null;
}): MemorySpace {
  switch (args.memoryIntent) {
    case 'screenshot_diagnosis_recall':
      return 'screenshot_diagnosis';

    case 'ir_diagnosis_recall':
    case 'diagnosis_followup':
      return 'ir_diagnosis';

    case 'relationship_recall':
    case 'relationship_followup':
      return 'relationship';

    case 'person_state_recall':
    case 'person_reference':
    case 'nickname_reference':
      return 'person';

    case 'project_context_recall':
      return 'project';

    case 'working_rule_recall':
      return 'long_term';

    case 'pending_offer_followup':
      return 'pending_offer';

    case 'active_thread_followup':
      return 'active_thread';

    case 'past_context_recall':
      return 'past_context';

    case 'current_state_recall':
      return 'state';

    case 'normal_chat':
      return 'normal';

    default:
      return 'unknown';
  }
}
