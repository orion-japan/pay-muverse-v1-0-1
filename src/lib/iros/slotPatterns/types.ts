export type PatternKey =
  | 'NORMAL_V1'
  | 'NORMAL_DETAIL_V1'
  | 'NORMAL_RESONANCE_V1'
  | 'NORMAL_PRACTICAL_RESONANCE_V1'
  | 'NORMAL_COMPRESSED_V1'
  | 'DECLARATION_RESONANCE_V1'
  | 'PARTNER_SIDE_RESONANCE_V1'
  | 'TRUTH_V1'
  | 'TRUTH_COMPRESSED_V1'
  | 'IR_LIGHT_V1'
  | 'IR_DETAIL_V1';

  export type PatternSlotKey =
  | 'TARGET'
  | 'OBS'
  | 'SHIFT'
  | 'NEXT'
  | 'SAFE'
  | 'STATE'
  | 'GUIDE'
  | 'MESSAGE'
  | 'STATE_SURFACE'
  | 'STATE_WEIGHT'
  | 'STATE_OPEN_EDGE'
  | 'STATE_RESIDUE'
  | 'STATE_ACTION';

  export type PatternBlockKey =
  | 'current_state'
  | 'misrecognition_negation'
  | 'structural_reframe'
  | 'breakdown_core_gap'
  | 'breakdown_defense'
  | 'breakdown_rejection_target'
  | 'reading_direction'
  | 'concrete_sort_axis'
  | 'concrete_sort_boundary'
  | 'concrete_sort_redesign'
  | 'felt_acceptance_point'
  | 'sting_point'
  | 'conclusion'
  | 'caution'
  | 'closing_line'
  | 'state_surface'
  | 'state_surface_2'
  | 'state_surface_3'
  | 'state_weight'
  | 'state_weight_2'
  | 'state_weight_3'
  | 'state_open_edge'
  | 'state_open_edge_2'
  | 'state_open_edge_3'
  | 'state_residue'
  | 'state_residue_2'
  | 'state_residue_3'
  | 'state_action'
  | 'state_action_2'
  | 'state_action_3';
export type PatternBlockSpec = {
  key: PatternBlockKey;
  required: boolean;
  minLines?: 1 | 2;
  maxLines?: 1 | 2 | 3;
};

export type PatternSlotSpec = {
  key: PatternSlotKey;
  heading?: string;
  blocks: PatternBlockSpec[];
};

export type PatternSpec = {
  key: PatternKey;
  mode: 'normal' | 'truth' | 'ir';
  slots: PatternSlotSpec[];
};

export type PatternBuildInput = {
  patternKey: PatternKey;
  targetLabel?: string | null;
  questionType?: string | null;
  goalKind?: string | null;
  detailMode?: boolean | null;
};

export type BuiltPatternBlock = {
  slotKey: PatternSlotKey;
  blockKey: PatternBlockKey;
  heading?: string;
  required: boolean;
};

export type PatternBuildResult = {
  patternKey: PatternKey;
  blocks: BuiltPatternBlock[];
};
