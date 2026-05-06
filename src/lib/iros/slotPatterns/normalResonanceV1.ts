import type { PatternSpec } from './types';

export const NORMAL_RESONANCE_V1: PatternSpec = {
  key: 'NORMAL_RESONANCE_V1',
  mode: 'normal',
  slots: [
    {
      key: 'STATE_SURFACE',
      blocks: [{ key: 'state_surface', required: true, minLines: 1, maxLines: 3 }],
    },
  ],
};
