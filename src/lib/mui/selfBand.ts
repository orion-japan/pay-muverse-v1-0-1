import type { SelfAcceptance } from './types';

/** estimateSelfAcceptance の返り値形の差を吸収して band を返す */
export function toSelfBand(self: SelfAcceptance): 'low' | 'mid' | 'high' {
  const score =
    typeof self === 'number' ? self : typeof self?.score === 'number' ? self.score : 0.5;
  if (score < 0.33) return 'low';
  if (score < 0.66) return 'mid';
  return 'high';
}
