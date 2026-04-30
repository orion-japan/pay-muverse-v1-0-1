import type { PatternSpec } from './types';

export const TRUTH_COMPRESSED_V1: PatternSpec = {
  key: 'TRUTH_COMPRESSED_V1',
  mode: 'truth',
  slots: [
    {
      key: 'OBS',
      blocks: [{ key: 'current_state', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'SHIFT',
      blocks: [{ key: 'breakdown_core_gap', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'NEXT',
      blocks: [{ key: 'reading_direction', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'SAFE',
      blocks: [{ key: 'conclusion', required: true, minLines: 1, maxLines: 2 }],
    },
  ],
};
