export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type QResult = {
  code: QCode;
  confidence: number;    // 0.0 - 1.0
  hint?: string;         // 短い説明
  color_hex?: string;    // UI用色
  stage?: string | null; // S1..T3 など（任意）
};

export type Intent = {
  target: 'self' | 'other' | 'task';
  valence: 'approach' | 'avoid' | 'neutral';
  timescale: 'past' | 'present' | 'future';
  actionability: 'low' | 'medium' | 'high';
  confidence: number;
};

export type Phase = 'Inner' | 'Outer';
export type SelfAcceptance = { score: number; band: '0_40' | '40_70' | '70_100' };
export type Relation = { label: 'tension' | 'harmony' | 'neutral'; confidence: number };

export type AffectAnalysis = {
  q: QResult;
  intent: Intent;
  phase: Phase;
  selfAcceptance: SelfAcceptance;
  relation: Relation;
};
