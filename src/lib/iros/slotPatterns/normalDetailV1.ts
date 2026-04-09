// src/lib/iros/slotPatterns/normalDetailV1.ts

import type { PatternSpec } from './types';

export const NORMAL_DETAIL_V1: PatternSpec = {
  key: 'NORMAL_DETAIL_V1',
  mode: 'normal',
  slots: [
    {
      key: 'OBS',
      blocks: [
        { key: 'current_state', required: true, minLines: 1, maxLines: 2 },
        { key: 'misrecognition_negation', required: true, minLines: 1, maxLines: 2 },
        { key: 'structural_reframe', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'SHIFT',
      blocks: [
        { key: 'breakdown_core_gap', required: true, minLines: 1, maxLines: 2 },
        { key: 'breakdown_defense', required: true, minLines: 1, maxLines: 2 },
        { key: 'breakdown_rejection_target', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'NEXT',
      blocks: [
        { key: 'reading_direction', required: true, minLines: 1, maxLines: 2 },
        { key: 'concrete_sort_axis', required: true, minLines: 1, maxLines: 2 },
        { key: 'concrete_sort_boundary', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'SAFE',
      blocks: [
        { key: 'conclusion', required: true, minLines: 1, maxLines: 2 },
        { key: 'caution', required: true, minLines: 1, maxLines: 2 },
        { key: 'closing_line', required: true, minLines: 1, maxLines: 2 },
      ],
    },
  ],
};
