// /src/lib/iros/config.ts
// 役割：古い import を壊さず、system.ts に一元化
// - 互換用に IROS_PROMPT をエイリアス提供（buildSystemPrompt()の即時値）
// - 今後は buildSystemPrompt の使用推奨

import { buildSystemPrompt, type Mode } from './system';

// 互換: 旧コードが期待する定数。実体は現行System Promptの即時生成値
export const IROS_PROMPT: string = buildSystemPrompt();

// そのまま再エクスポート（他モジュールが import しやすいように）
export { buildSystemPrompt };
export type { Mode };

// 後方互換のための最小型（既存参照があってもビルドが通る）
export type Analysis = {
  phase2: 'Inner' | 'Outer';
  depth2: string;
  q2: string;
  [key: string]: unknown;
};

/* ===== 追加（非言語ヒントの型）===== */
// ラベルはDBと一致させる（Q1..Q5）
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type Phase = 'Inner' | 'Outer';
// Depth は S1..I3..T3 を含む自由度のため string として運用
export type Depth = string;

// 共鳴場（Mirror）から渡す非言語状態
export type ResonanceState = {
  phase?: Phase;
  depthHint?: Depth;
  qHint?: QCode;
  field?: string[];                 // 例: ["open","protected"]
  vector?: Record<string, number>;  // 例: { joy:0.6, calm:0.4, ... }
  shield?: boolean;
  hold?: boolean;
};

// 意図の瞬間的パルス（任意）
export type IntentPulse = {
  topic?: string;
  wish?: string;
  risk?: string;
  tags?: string[];
};
