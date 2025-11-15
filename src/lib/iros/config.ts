// src/lib/iros/config.ts
// 役割：最小 import を保持しつつ system.ts に一元化
// - 既定用 IROS_PROMPT: 単純なレイヤレス提供（IROS_SYSTEM の即時値）
// - 新API: getSystemPrompt（旧 buildSystemPrompt の役割）
// - Mode / Analysis / Depth / QCode / ResonanceState などを共鳴モジュール全体で共通化できるよう統一

import IROS_SYSTEM, { getSystemPrompt } from './system';

export type Mode = string;

// 既定の System Prompt（旧コード互換）
export const IROS_PROMPT: string = IROS_SYSTEM;

// 旧コードが参照する `buildSystemPrompt()` を getSystemPrompt にマッピング
export const buildSystemPrompt = getSystemPrompt;

// -----------------------------------------------
// 以下は既存プロジェクトが参照する最低限の互換型
// -----------------------------------------------

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
  field?: string[];
  vector?: Record<string, number>;
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
