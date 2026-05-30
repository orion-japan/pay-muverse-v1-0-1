import type { MemoryRouterDecision } from './memoryRouter';

export type MemoryGuardDecision = {
  memoryDecision: MemoryRouterDecision;
  allowWriterSeed: boolean;
  allowLongTermSave: boolean;
  allowPastStateMerge: boolean;
  allowDiagnosisSave: boolean;
  allowRelationshipSave: boolean;
  guardReasons: string[];
};

export function guardIrosMemoryDecision(
  memoryDecision: MemoryRouterDecision
): MemoryGuardDecision {
  const guardReasons: string[] = [];

  const isCurrentTurnWorkingReference =
    memoryDecision.memoryIntent === 'reference_check' &&
    memoryDecision.memorySpace === 'working' &&
    memoryDecision.recallMode === 'current_turn' &&
    memoryDecision.workingReference !== null;

  if (isCurrentTurnWorkingReference) {
    guardReasons.push('current_turn_working_reference');
    guardReasons.push('do_not_save_to_long_term_memory');
    guardReasons.push('do_not_merge_into_past_state');
    guardReasons.push('do_not_save_as_diagnosis_memory');
    guardReasons.push('do_not_save_as_relationship_memory');

    return {
      memoryDecision,
      allowWriterSeed: true,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      allowDiagnosisSave: false,
      allowRelationshipSave: false,
      guardReasons,
    };
  }

  if (memoryDecision.confidence < 0.5) {
    guardReasons.push('low_confidence_memory_decision');
  }

  return {
    memoryDecision,
    allowWriterSeed: memoryDecision.memoryIntent !== 'no_memory',
    allowLongTermSave: memoryDecision.memoryIntent !== 'no_memory',
    allowPastStateMerge: memoryDecision.memoryIntent !== 'no_memory',
    allowDiagnosisSave: memoryDecision.memoryIntent === 'diagnosis_recall',
    allowRelationshipSave: memoryDecision.memoryIntent === 'relationship_recall',
    guardReasons,
  };
}
