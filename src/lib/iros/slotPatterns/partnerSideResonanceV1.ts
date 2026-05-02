import type { PatternSpec } from './types';

export const PARTNER_SIDE_RESONANCE_V1: PatternSpec = {
  key: 'PARTNER_SIDE_RESONANCE_V1',
  mode: 'normal',
  slots: [
    {
      key: 'STATE_SURFACE',
      blocks: [{ key: 'state_surface', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'STATE_WEIGHT',
      blocks: [{ key: 'state_weight', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'STATE_OPEN_EDGE',
      blocks: [{ key: 'state_open_edge', required: true, minLines: 1, maxLines: 2 }],
    },
    {
      key: 'STATE_ACTION',
      blocks: [{ key: 'state_action', required: true, minLines: 1, maxLines: 2 }],
    },
  ],
};
