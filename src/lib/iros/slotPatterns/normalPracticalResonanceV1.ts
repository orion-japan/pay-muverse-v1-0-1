// src/lib/iros/slotPatterns/normalPracticalResonanceV1.ts

import type { PatternSpec } from './types';

export const NORMAL_PRACTICAL_RESONANCE_V1: PatternSpec = {
  key: 'NORMAL_PRACTICAL_RESONANCE_V1',
  mode: 'normal',
  slots: [
    {
      key: 'OBS',
      blocks: [
        { key: 'current_state', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'NEXT',
      blocks: [
        { key: 'state_action', required: true, minLines: 1, maxLines: 2 },
      ],
    },
    {
      key: 'SAFE',
      blocks: [
        { key: 'caution', required: true, minLines: 1, maxLines: 2 },
        { key: 'closing_line', required: false, minLines: 1, maxLines: 1 },
      ],
    },
  ],
};
