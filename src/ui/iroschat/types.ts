// /src/ui/iroschat/types.ts
// Iros 専用型（UI全体で共通利用）

export type Role = 'user' | 'assistant' | 'system';

// Qコード（将来の拡張用）
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type IrosConversation = {
  id: string;              // uuid
  title?: string | null;
  created_at?: string;     // ISO
  updated_at?: string;     // ISO
  agent?: string | null;   // 混在防止用（任意）
};

export type IrosMessageMeta = {
  q?: QCode | null;
  phase?: 'Inner' | 'Outer' | string | null;
  depth?: string | null;         // 例: S1..I3
  confidence?: number | null;    // 0..1
  mode?: string | null;          // Light/Deep/...
  [k: string]: any;
};

export type IrosMessage = {
  id: string;              // bigint → string で安全に
  role: Role;
  content?: string;        // API側の命名互換
  text?: string;           // UI側の命名互換
  created_at?: string;     // ISO
  ts?: number;             // number(ms) 表示用
  q?: QCode;
  color?: string;
  meta?: IrosMessageMeta | Record<string, any> | null;
};

export type IrosUserInfo = {
  id: string;
  name?: string;
  userType?: string;
  credits?: number;
};

// 互換のためのエイリアス（他ファイルが Conversation を import していても通る）
export type Conversation = IrosConversation;
