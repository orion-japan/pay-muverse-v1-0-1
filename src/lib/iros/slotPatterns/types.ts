export type PatternKey =
  | 'NORMAL_V1'
  | 'TRUTH_V1'
  | 'IR_LIGHT_V1'
  | 'IR_DETAIL_V1';

export type PatternSlotKey =
  | 'TARGET'
  | 'OBS'
  | 'STATE'
  | 'GUIDE'
  | 'MESSAGE';

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
  | 'conclusion'
  | 'caution'
  | 'closing_line';

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
