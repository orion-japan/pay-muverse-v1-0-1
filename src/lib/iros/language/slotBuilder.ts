// src/lib/iros/language/slotBuilder.ts
// iros — Slot Builder（スロット生成）
// - Frame（器）に対して「中身の枠（slot）」を用意する（本文はまだ作らない）
// - DescentGateState は union を正とする（closed/offered/accepted）

import type { FrameKind, DescentGateState } from './frameSelector';
import type { SpinLoop } from '../types';

export type SlotKey = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';

export type SlotPlan = {
  frame: FrameKind;
  slots: Record<SlotKey, string | null>;
};

export type BuildSlotsContext = {
  descentGate: DescentGateState | boolean | null | undefined; // 互換：旧booleanも許可
  spinLoop?: SpinLoop | null | undefined; // ✅ 追加：回転ループ（TCF なら下降扱い）
};

function normalizeDescentGate(
  v: DescentGateState | boolean | null | undefined
): DescentGateState {
  if (v === true) return 'accepted';
  if (v === false) return 'closed';
  if (v === 'closed' || v === 'offered' || v === 'accepted') return v;
  return 'closed';
}

function normalizeSpinLoop(v: unknown): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function baseSlots(): Record<SlotKey, string | null> {
  return {
    OBS: null,
    SHIFT: null,
    NEXT: null,
    SAFE: null,
  };
}

/**
 * Slot を組み立てる
 * - 値は「Writer が参照する短い指示文（タグ）」として返す
 * - truthy / falsy でログに出せるよう null を使う
 */
export function buildSlots(frame: FrameKind, ctx: BuildSlotsContext): SlotPlan {
  const dg = normalizeDescentGate(ctx?.descentGate);
  const loop = normalizeSpinLoop(ctx?.spinLoop);
  const slots = baseSlots();

  // --- 下降ゲート（安全・減速） ---
  // offered/accepted のときは SAFE を必ず立てる（問いの圧を下げる/守る）
  if (dg !== 'closed') {
    slots.SAFE =
      dg === 'offered' ? 'SAFE:descent-offered' : 'SAFE:descent-accepted';
  } else {
    // ✅ 追加：dg が closed でも「TCF(下降)」なら SAFE を立てる
    // - 下降回転のときは、ユーザーが「踏み込まれたくない」方向に寄りやすいので、
    //   Slot側で常に安全ギアを入れる（FramePlan.required の整合も取れる）
    if (loop === 'TCF') {
      slots.SAFE = 'SAFE:spin-tcf';
    }
  }

  // --- Frame ごとの最小スロット ---
  switch (frame) {
    case 'MICRO': {
      slots.OBS = 'OBS:micro';
      slots.NEXT = 'NEXT:one-step';
      // SHIFT は入れない（短文崩れ防止）
      break;
    }

    case 'NONE': {
      // 基本スロット無し（素の返答）
      // ただし SAFE は残りうる（下降 / 安全ギア）
      break;
    }

    case 'S': {
      slots.OBS = 'OBS:self';
      slots.SHIFT = 'SHIFT:self';
      slots.NEXT = 'NEXT:self';
      break;
    }

    case 'R': {
      slots.OBS = 'OBS:resonance';
      slots.SHIFT = 'SHIFT:resonance';
      slots.NEXT = 'NEXT:resonance';
      break;
    }

    case 'C': {
      slots.OBS = 'OBS:creation';
      // C は “動ける形” 優先なので NEXT を強める
      slots.NEXT = 'NEXT:action';
      // SHIFT は任意だが、下降中以外なら入れて良い
      if (dg === 'closed') slots.SHIFT = 'SHIFT:reframe';
      break;
    }

    case 'F': {
      // F = 定着・支える（落下や反発を抑え、足場を作る）
      slots.OBS = 'OBS:stabilize';
      slots.SHIFT = 'SHIFT:stabilize';
      slots.NEXT = 'NEXT:small-step';
      // SAFE は dg/loop 側で既に立つ。closed でも薄く保険を置きたい場合のみ上書き
      if (dg === 'closed' && !slots.SAFE) slots.SAFE = 'SAFE:stabilize';
      break;
    }

    case 'I': {
      slots.OBS = 'OBS:intention';
      slots.SHIFT = 'SHIFT:intention';
      slots.NEXT = 'NEXT:intention';
      break;
    }

    case 'T': {
      slots.OBS = 'OBS:transcend';
      // T は「気づき」優先、NEXT は控えめ
      slots.SHIFT = 'SHIFT:insight';
      slots.NEXT = 'NEXT:soft';
      break;
    }

    default: {
      // 将来拡張用：何もしない
      break;
    }
  }

  return { frame, slots };
}
