// src/lib/iros/will/continuityEngine.ts

import type { Depth, QCode } from '../system';
import type { IrosGoal } from './goalEngine';

export type ContinuityContext = {
  // ★ optional をやめる：呼び出し側で必ず渡す（無いなら null）
  lastDepth: Depth | null;
  lastQ: QCode | null;
  userText?: string;
};

// 深層トリガー語（I3へ昇格させる単語）
const DEEP_TRIGGER = [
  '深層',
  '深い意図',
  '核',
  '本質',
  '中心',
  'フィールドを見て',
  'フィールドから',
  'T層',
  'T1',
  'T2',
  'T3',
];

export function applyGoalContinuity(
  goal: IrosGoal,
  ctx: ContinuityContext,
): IrosGoal {
  const { lastDepth, lastQ, userText } = ctx;

  let adjusted: IrosGoal = { ...goal };

  // ① 深層トリガー → I3 優先
  if (userText) {
    const hit = DEEP_TRIGGER.some((word) => userText.includes(word));
    if (hit) adjusted = { ...adjusted, targetDepth: 'I3' };
  }

  // ② Depth の連続性（ジャンプ調整）
  if (lastDepth && adjusted.targetDepth) {
    adjusted = {
      ...adjusted,
      targetDepth: softenDepthJump(lastDepth, adjusted.targetDepth),
    };
  } else if (!adjusted.targetDepth && lastDepth) {
    adjusted = { ...adjusted, targetDepth: lastDepth };
  }

  // ③ Q の継続は "goal" では扱わない（analysis/applyQContinuity に一本化）
  //    ここで lastQ を targetQ に入れると、currentQ が一瞬でも落ちたターンに
  //    buildFinalMeta が goalQ を拾って「前回Qに戻る」経路が成立するため。

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/CONT continuity]', {
      lastDepth,
      lastQ,
      finalDepth: adjusted.targetDepth,
      // finalQ は "goal.targetQ" の状態（継承しない）
      finalQ: adjusted.targetQ ?? null,
    });
  }

  return adjusted;
}

/* ========= 内部：Depthジャンプのなだらか化 ========= */

const DEPTH_SEQUENCE: Depth[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'R1',
  'R2',
  'R3',
  'C1',
  'C2',
  'C3',
  'I1',
  'I2',
  'I3',
];

function softenDepthJump(last: Depth, target: Depth): Depth {
  if (last === target) return target;

  const fromIndex = DEPTH_SEQUENCE.indexOf(last);
  const toIndex = DEPTH_SEQUENCE.indexOf(target);

  if (fromIndex === -1 || toIndex === -1) return target;

  const diff = toIndex - fromIndex;

  // 1段以内なら許容
  if (Math.abs(diff) <= 1) return target;

  // 2段以上 → 1段だけ進める
  const step = diff > 0 ? 1 : -1;
  const nextIndex = fromIndex + step;

  if (nextIndex < 0 || nextIndex >= DEPTH_SEQUENCE.length) {
    return target;
  }

  return DEPTH_SEQUENCE[nextIndex];
}
