import type { PatternSpec } from './types';

export const BOOK_AUTHOR_MODE_V1: PatternSpec = {
  key: 'BOOK_AUTHOR_MODE_V1',
  mode: 'normal',
  slots: [
    {
      key: 'OBS',
      heading: '読者の問いを受け取る',
      blocks: [
        { key: 'current_state', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'SHIFT',
      heading: '第1巻のかがみで映す',
      blocks: [
        { key: 'structural_reframe', required: true, minLines: 1, maxLines: 2 },
        { key: 'reading_direction', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'STATE',
      heading: '内面に立ち上がる景色',
      blocks: [
        { key: 'state_surface', required: true, minLines: 1, maxLines: 2 },
        { key: 'state_weight', required: false, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'GUIDE',
      heading: '創造の方向',
      blocks: [
        { key: 'conclusion', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'NEXT',
      heading: '次に置ける一文',
      blocks: [
        { key: 'closing_line', required: true, minLines: 1, maxLines: 2 },
      ],
    },
  ],
};
