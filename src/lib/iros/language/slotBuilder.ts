// src/lib/iros/language/slotBuilder.ts
// iros — Layer D: Slot Builder（スロット生成）
// - 入力: frame + 最低限の meta（descentGate など）
// - 出力: slots（本文はまだ作らない）
// - LLM禁止（純関数）

import type { DescentGateState } from '@/lib/iros/rotation/rotationLoop';
import type { FrameKind } from './frameSelector';

export type SlotId = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';

export type SlotPlan = {
  slots: Record<SlotId, boolean>;
};

export type SlotBuilderMeta = {
  /**
   * ✅ 方針：descentGate は union を正とする
   * 互換：古い boolean が来ても吸収
   */
  descentGate?: DescentGateState | boolean | null;
};

function isDown(descentGate?: DescentGateState | boolean | null): boolean {
  if (descentGate == null) return false;
  if (typeof descentGate === 'boolean') return descentGate; // 互換：true=下降中扱い
  return descentGate === 'offered' || descentGate === 'accepted';
}

/**
 * buildSlots
 * - frame ごとに「器の中身（スロット）」を最小構成で用意する
 * - 返すのは boolean map（true のものだけ renderer が埋める）
 */
export function buildSlots(frame: FrameKind, meta?: SlotBuilderMeta): SlotPlan {
  const down = isDown(meta?.descentGate);

  // 最小セット（共通）
  const base: Record<SlotId, boolean> = {
    OBS: true,
    SHIFT: true,
    NEXT: true,
    SAFE: false,
  };

  // 落下中（offered/accepted/true）は SAFE を入れてもいいが、
  // いまは「出力汚染防止」を優先して OFF のまま（必要なら true に切替）
  if (down) {
    base.SAFE = false;
  }

  // frame 別の最小構成
  switch (frame) {
    case 'MICRO':
      return {
        slots: {
          OBS: true,
          SHIFT: false,
          NEXT: true,
          SAFE: false,
        },
      };

    case 'NONE':
      // 素の返答でも、最低限は同じ（OBS/SHIFT/NEXT）
      return { slots: base };

    case 'C':
      // 実務/手順：OBS + NEXT を強め、SHIFT は状況次第（今回はONのまま）
      return { slots: base };

    case 'S':
    case 'R':
    case 'I':
    case 'T':
    case 'F':
      return { slots: base };

    default:
      return { slots: base };
  }
}
