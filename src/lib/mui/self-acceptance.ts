import type { SelfBand, SelfAcceptance } from '@/lib/mui/types';
import { normalizeBand } from '@/lib/mui/types';

export function normalizeSelfAcceptance(x: unknown): { score: number; band: SelfBand } {
  if (typeof x === 'number') {
    const score = clamp01(x) * 100;
    return { score, band: scoreToBand(score) };
  }
  if (x && typeof x === 'object') {
    const any = x as Partial<SelfAcceptance>;
    const score = typeof any.score === 'number' ? any.score : 50;
    const band = normalizeBand(any.band ?? scoreToBand(score));
    return { score, band };
  }
  return { score: 50, band: '40_70' };
}

function clamp01(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.5;
}
function scoreToBand(score: number): SelfBand {
  if (score < 20) return 'lt20';
  if (score < 40) return '20_40';
  if (score < 70) return '40_70';
  if (score < 90) return '70_90';
  return 'gt90';
}
