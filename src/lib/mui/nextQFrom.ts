// src/lib/mui/nextQFrom.ts
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type Phase = 'Inner' | 'Outer' | 'Bridge' | 'Flow' | 'Calm';

// band は見かけの揺れに合わせて広めに許容
export type SelfBand = 'lt20' | '10_40' | '20_40' | '40_70' | '70_90' | 'gt90';

export function nextQFrom(current: QCode, phase: Phase): QCode {
  // シンプルな遷移規則（必要ならロジックを後で強化）
  switch (current) {
    case 'Q1': return phase === 'Outer' ? 'Q2' : 'Q1';
    case 'Q2': return phase === 'Inner' ? 'Q3' : 'Q2';
    case 'Q3': return phase === 'Bridge' ? 'Q4' : 'Q3';
    case 'Q4': return phase === 'Flow' ? 'Q5' : 'Q4';
    case 'Q5': default: return 'Q5';
  }
}
