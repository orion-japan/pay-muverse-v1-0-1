// src/lib/iros/types.ts

export type IrosMode = 'auto' | 'surface' | 'core';

export type IrosChatRequest = {
  conversationId: string;
  userText: string;
  mode?: IrosMode;
  // 将来: 画像/ファイルを付けたい場合ここに追加
  idempotencyKey?: string; // 台帳の一意キーとして meta に入れる（重複課金防止用に推奨）
};

export type IrosCredit = {
  ok: boolean;
  balance: number; // 消費後残高（不明時 -1）
  tx_id: string;
  error?: string | null;
};

/**
 * Iros が保存する軽量メモリ
 * - summary      : Q/A の短い要約
 * - depth        : 深度ラベル（例: 'S2' / 'I2' など）
 * - tone         : トーン（'consult' / 'reflective' / 'creative' など）
 * - theme        : テーマ名（mode などをそのまま入れてもよい）
 * - last_keyword : 直近のキーワード（検索用）
 */
export type IrosMemory = {
  summary: string;
  depth: string;
  tone: string;
  theme: string;
  last_keyword: string;
};

export type IrosChatResponse =
  | {
      ok: true;
      reply: string;
      layer: 'Surface' | 'Core';
      credit: IrosCredit;
      memory: IrosMemory;
    }
  | {
      ok: false;
      error: string;
      code?: string;
    };
