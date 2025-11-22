// src/lib/iros/will/continuityEngine.ts
// Iros Continuity Engine — 意志の連続性 + I3ブースト
//
// ・前回の Depth / Q を参考に「なだらかに」進める
// ・「深層トリガー語」が出たら I3 を優先
// ・ Continuity が決めた targetDepth / targetQ を Goal に反映
// ・ NODE_ENV !== 'production' のときだけログ出力

import type { Depth, QCode } from '../system';
import type { IrosGoal } from './goalEngine';

export type ContinuityContext = {
  lastDepth?: Depth;
  lastQ?: QCode;
  userText?: string; // ★ 元のユーザー発話（深層トリガー判定用）
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

/**
 * applyGoalContinuity
 *  - Goal.targetDepth / targetQ を「前回の状態」＋「深層トリガー」で補正する
 *  - I層へ向かいそうな流れはスムーズに進める
 */
export function applyGoalContinuity(
  goal: IrosGoal,
  ctx: ContinuityContext,
): IrosGoal {
  const { lastDepth, lastQ, userText } = ctx;

  let adjusted: IrosGoal = { ...goal };

  /* =========================================================
     ① 「深層トリガー語」が text に含まれる場合 → I3 を最優先
  ========================================================= */
  if (userText) {
    const hit = DEEP_TRIGGER.some((word) => userText.includes(word));
    if (hit) {
      adjusted = { ...adjusted, targetDepth: 'I3' };
    }
  }

  /* =========================================================
     ② Depth の連続性（ジャンプ調整）
  ========================================================= */
  if (lastDepth && adjusted.targetDepth) {
    adjusted = {
      ...adjusted,
      targetDepth: softenDepthJump(lastDepth, adjusted.targetDepth),
    };
  } else if (!adjusted.targetDepth && lastDepth) {
    adjusted = {
      ...adjusted,
      targetDepth: lastDepth,
    };
  }

  /* =========================================================
     ③ 前回の Q を引き継ぐ
  ========================================================= */
  if (!adjusted.targetQ && lastQ) {
    adjusted = {
      ...adjusted,
      targetQ: lastQ,
    };
  }

  /* =========================================================
     ④ 開発時のみログ（本番では出さない）
  ========================================================= */
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[IROS/CONT continuity]', {
      lastDepth,
      lastQ,
      finalDepth: adjusted.targetDepth,
      finalQ: adjusted.targetQ,
    });
  }

  return adjusted;
}

/* ========= 内部：Depthジャンプのなだらか化 ========= */

const DEPTH_SEQUENCE: Depth[] = [
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
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
