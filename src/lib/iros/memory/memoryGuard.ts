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

function hasStableTarget(memoryDecision: MemoryRouterDecision): boolean {
  return Boolean(
    String(memoryDecision.targetKey ?? '').trim() ||
      String(memoryDecision.relationId ?? '').trim() ||
      String(memoryDecision.projectKey ?? '').trim(),
  );
}

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
    guardReasons.push('allow_writer_seed_only');
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

  if (memoryDecision.memoryIntent === 'no_memory') {
    guardReasons.push('no_memory_route');
    guardReasons.push('block_all_memory_channels');

    return {
      memoryDecision,
      allowWriterSeed: false,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      allowDiagnosisSave: false,
      allowRelationshipSave: false,
      guardReasons,
    };
  }

  if (memoryDecision.confidence < 0.5) {
    guardReasons.push('low_confidence_memory_decision');
    guardReasons.push('block_writer_seed');
    guardReasons.push('block_all_memory_saves');

    return {
      memoryDecision,
      allowWriterSeed: false,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      allowDiagnosisSave: false,
      allowRelationshipSave: false,
      guardReasons,
    };
  }

  if (memoryDecision.memoryIntent === 'diagnosis_recall') {
    const targetOk =
      memoryDecision.memorySpace === 'diagnosis' &&
      Boolean(String(memoryDecision.targetKey ?? '').trim());

    if (!targetOk) {
      guardReasons.push('diagnosis_recall_without_stable_target');
      guardReasons.push('block_diagnosis_save');
    }

    guardReasons.push('diagnosis_channel_only');
    guardReasons.push('do_not_save_to_long_term_memory');
    guardReasons.push('do_not_merge_into_past_state');
    guardReasons.push('do_not_save_as_relationship_memory');

    return {
      memoryDecision,
      allowWriterSeed: targetOk,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      allowDiagnosisSave: targetOk,
      allowRelationshipSave: false,
      guardReasons,
    };
  }

  if (memoryDecision.memoryIntent === 'relationship_recall') {
    const hasTargetLabel = Boolean(String(memoryDecision.targetLabel ?? '').trim());
    const hasTargetKey = Boolean(String(memoryDecision.targetKey ?? '').trim());
    const targetOk = memoryDecision.memorySpace === 'relationship' && hasTargetLabel;

    if (!hasTargetKey) {
      guardReasons.push('relationship_recall_deictic_or_unstable_target');
      guardReasons.push('allow_writer_seed_but_block_relationship_save');
    }

    guardReasons.push('relationship_channel_only');
    guardReasons.push('do_not_save_to_long_term_memory');
    guardReasons.push('do_not_merge_into_past_state');
    guardReasons.push('do_not_save_as_diagnosis_memory');

    return {
      memoryDecision,
      allowWriterSeed: targetOk,
      allowLongTermSave: false,
      allowPastStateMerge: false,
      allowDiagnosisSave: false,
      allowRelationshipSave: targetOk && hasTargetKey,
      guardReasons,
    };
  }

  if (
    memoryDecision.memoryIntent === 'working_rule_recall' ||
    memoryDecision.memorySpace === 'development'
  ) {
    guardReasons.push('working_rule_or_development_context');
    guardReasons.push('do_not_save_as_person_or_relationship_memory');

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

  if (!hasStableTarget(memoryDecision) && memoryDecision.recallMode !== 'explicit') {
    guardReasons.push('unstable_memory_target');
    guardReasons.push('block_saves_but_allow_writer_context');

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

  guardReasons.push('general_memory_context');

  return {
    memoryDecision,
    allowWriterSeed: true,
    allowLongTermSave: memoryDecision.memorySpace === 'general',
    allowPastStateMerge:
      memoryDecision.memoryIntent === 'past_context_recall' ||
      memoryDecision.memoryIntent === 'current_state_recall' ||
      memoryDecision.memoryIntent === 'person_state_recall',
    allowDiagnosisSave: false,
    allowRelationshipSave: false,
    guardReasons,
  };
}