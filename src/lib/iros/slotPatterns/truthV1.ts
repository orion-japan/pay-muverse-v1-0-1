import type { PatternSpec } from './types';

export const TRUTH_V1: PatternSpec = {
  key: 'TRUTH_V1',
  mode: 'truth',
  slots: [
    {
      key: 'OBS',
      blocks: [
        { key: 'current_state', required: true, minLines: 1, maxLines: 2 },
        { key: 'misrecognition_negation', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'STATE',
      blocks: [
        { key: 'structural_reframe', required: true, minLines: 1, maxLines: 2 },
        { key: 'breakdown_core_gap', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'GUIDE',
      blocks: [
        { key: 'reading_direction', required: true, minLines: 1, maxLines: 2 },
        { key: 'felt_acceptance_point', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'MESSAGE',
      blocks: [
        { key: 'conclusion', required: true, minLines: 1, maxLines: 2 },
        { key: 'closing_line', required: true, minLines: 1, maxLines: 2 },
      ],
    },
  ],
};
