// src/lib/iros/server/buildSlotPlan.ts （例）

import { SHIFT_PRESET_C_SENSE_HINT } from '@/lib/iros/language/shiftPresets';

function buildShiftSlot(meta: {
  depthStage?: string | null;
}) {
  if (meta.depthStage?.startsWith('C')) {
    return {
      type: 'SHIFT',
      value: SHIFT_PRESET_C_SENSE_HINT,
    };
  }

  // 既存の I / T 用 SHIFT（そのまま）
  return {
    type: 'SHIFT',
    value: {
      kind: 'meaning_first',
      rules: {
        answer_user_meaning: true,
        no_lecture: true,
        no_checklist: true,
        questions_max: 1,
      },
      allow: {
        concrete_reply: true,
        short_reply_ok: true,
      },
    },
  };
}
