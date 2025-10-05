// src/lib/mui/types.ts
export type Phase = 'Inner' | 'Outer' | 'Bridge' | 'Flow' | 'Calm';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

/** band は表記揺れを吸収するため広めに許容 */
export type SelfBand = 'lt20' | '10_40' | '20_40' | '40_70' | '70_90' | 'gt90';

export type SelfAcceptance = {
  score: number;   // 0-100
  band: SelfBand;
};

export type RelationQuality = {
  label: 'harmony' | 'discord' | 'neutral';
  confidence?: number;
};

/** 返ってきた band を既定の型に正規化（任意で使用） */
export function normalizeBand(b: string | null | undefined): SelfBand {
  const t = String(b ?? '').trim();
  if (t === 'lt20') return 'lt20';
  if (t === '10_40') return '10_40';
  if (t === '20_40') return '20_40';
  if (t === '40_70') return '40_70';
  if (t === '70_90') return '70_90';
  if (t === 'gt90') return 'gt90';
  return '40_70';
}
