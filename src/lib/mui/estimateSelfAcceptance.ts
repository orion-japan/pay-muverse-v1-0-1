// src/lib/mui/estimateSelfAcceptance.ts

/** 超簡易スコアリング（0..1）→ 0-100などに換算して使ってOK */
export function estimateSelfAcceptance(text: string): number {
  const neg = (text.match(/(無理|最悪|ダメ|嫌い|無価値|絶望)/g) || []).length;
  const pos = (text.match(/(大丈夫|やれそう|落ち着く|安心|希望)/g) || []).length;
  const score = 0.5 + (pos - neg) * 0.05;
  return Math.max(0, Math.min(1, score));
}
