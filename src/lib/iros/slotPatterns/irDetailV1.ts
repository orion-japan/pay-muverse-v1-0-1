import type { PatternSpec } from './types';

export const IR_DETAIL_V1: PatternSpec = {
  key: 'IR_DETAIL_V1',
  mode: 'ir',
  slots: [
    {
      key: 'OBS',
      heading: '🧿 観測結果',
      blocks: [
        { key: 'current_state', required: true, minLines: 1, maxLines: 2 },
        { key: 'misrecognition_negation', required: true, minLines: 1, maxLines: 2 },
        { key: 'structural_reframe', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'STATE',
      heading: '🌿 意識状態',
      blocks: [
        { key: 'breakdown_core_gap', required: true, minLines: 1, maxLines: 2 },
        { key: 'breakdown_defense', required: true, minLines: 1, maxLines: 2 },
        { key: 'breakdown_rejection_target', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'GUIDE',
      heading: '🪔 必要な整理',
      blocks: [
        { key: 'reading_direction', required: true, minLines: 1, maxLines: 2 },
        { key: 'concrete_sort_axis', required: true, minLines: 1, maxLines: 2 },
        { key: 'concrete_sort_boundary', required: true, minLines: 1, maxLines: 2 },
        { key: 'concrete_sort_redesign', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'MESSAGE',
      heading: '🌱 メッセージ',
      blocks: [
        { key: 'conclusion', required: true, minLines: 1, maxLines: 2 },
        { key: 'caution', required: true, minLines: 1, maxLines: 2 },
        { key: 'closing_line', required: true, minLines: 1, maxLines: 2 },
      ],
    },
  ],
};
