// src/lib/iros/memory/types.ts
export type Phase = 'Inner' | 'Outer';
export type Depth = 'S1' | 'S2' | 'S3' | 'R1' | 'R2' | 'C1' | 'C2' | 'I1' | 'I2' | 'I3' | 'T1' | 'T2' | 'T3';
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type ResonanceMetrics = {
  phase?: Phase;
  depth?: Depth;
  q_primary?: QCode;
  q_secondary?: QCode;
  polarity_avg?: number;       // -1.0〜+1.0 の平均
  self_acceptance_avg?: number;// 0〜1
};

export type RootIds = {
  userId: string;              // uuid
  conversationId: string;      // uuid
};

export type EvidenceCard = {
  id: string;                  // episode id or "st-context"
  title?: string;
  date?: string;               // ISO
  snippet: string;             // 抜粋
  trust?: number;
};

export type RetrievalBundle = {
  miniSummary: string;         // 直近要約（ST-Context）
  objectiveLine: string;       // 目的一句
  evidences: EvidenceCard[];   // 根拠カード（最大3〜5）
  metrics: ResonanceMetrics;   // 共鳴指標サマリ
};
