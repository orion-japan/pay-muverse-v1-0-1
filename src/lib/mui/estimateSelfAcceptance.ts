export type SelfAcceptance = { score: number; band: '40_70' | '70_90' | '10_40' };

export function estimateSelfAcceptance(text: string): SelfAcceptance {
  // とりあえず “67” に反応 / なければ 50
  const m = text.match(/\b([1-9]\d?|100)\b/);
  const score = m ? Math.min(100, Math.max(0, Number(m[1]))) : 50;
  const band: SelfAcceptance['band'] =
    score >= 70 ? '70_90' : score < 40 ? '10_40' : '40_70';
  return { score, band };
}
