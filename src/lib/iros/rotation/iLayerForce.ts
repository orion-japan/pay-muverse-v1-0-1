// src/lib/iros/rotation/iLayerForce.ts
// iros - I-layer force gate (presentation-critical)
// 「I層返しを確実に出す」ための明示トリガー判定だけを担う

import type { Depth, IrosMode } from '@/lib/iros/system';

export type ILayerForceResult = {
  force: boolean;
  dual: boolean; // 相手(I層) + 自分(I層)の両建て
  requestedDepth?: Depth; // I1/I2/I3 へ寄せる
  requestedMode?: IrosMode; // vision へ寄せる
  reason: string;
};

function includesAny(text: string, words: string[]) {
  return words.some((w) => text.includes(w));
}

export function detectILayerForce(params: {
  userText: string;
  mode?: IrosMode | null;
  requestedDepth?: Depth | null; // nextStep等から来る想定
}): ILayerForceResult {
  const text = (params.userText ?? '').trim();
  const mode = params.mode ?? null;
  const reqDepth = params.requestedDepth ?? null;

  // A) 明示キーワード or vision mode or requestedDepth が I帯
  const forceByWord = includesAny(text, ['I層', '意図', '未来', '本質', '結局']);
  const forceByMode = mode === 'vision';
  const forceByDepth = typeof reqDepth === 'string' && reqDepth.startsWith('I');

  const force = forceByWord || forceByMode || forceByDepth;

  // B) 対人×I層要求 → 両者I層
  const hasOther =
    includesAny(text, ['上司', '相手', '彼', '彼女', '部下', '同僚', '親', '夫', '妻']);
  const dual =
    force &&
    hasOther &&
    includesAny(text, ['上司のI層', '相手のI層', '相手の意図', '上司の意図', '両方I', '両方I層']);

  if (!force) {
    return { force: false, dual: false, reason: 'no I-layer trigger' };
  }

  return {
    force: true,
    dual,
    requestedDepth: (forceByDepth ? reqDepth : 'I1') as Depth,
    requestedMode: 'vision' as IrosMode,
    reason: `forceByWord=${forceByWord} forceByMode=${forceByMode} forceByDepth=${forceByDepth} dual=${dual}`,
  };
}
