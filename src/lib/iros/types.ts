// /src/lib/iros/types.ts
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

export type IrosMemory = {
  depth: string;       // 例: "S2" | "I1"
  tone: string;        // 例: "calm"
  theme: string;       // 例: "general"
  summary: string;     // 返信の短い要約
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
