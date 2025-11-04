// src/ui/iroschat/types.ts
// Iros 専用型

export type Role = 'user' | 'assistant';

// Qコード（他モジュールから参照されるため追加）
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type IrosConversation = {
  id: string; // uuid
  title: string;
  created_at?: string; // ISO
  updated_at?: string; // ISO
};

export type IrosMessage = {
  id: string; // bigint → string で安全に
  role: Role;
  content: string;
  created_at: string; // ISO (ts/createdAt補完済み)
  // 任意: 旧UI互換で残す（未使用でも害なし）
  q?: QCode;
  color?: string;
  meta?: Record<string, any>;
};

export type IrosUserInfo = {
  id: string;
  name?: string;
  userType?: string;
  credits?: number;
};

export type IrosClient = {
  listConversations(): Promise<IrosConversation[]>;
  fetchMessages(conversationId: string): Promise<IrosMessage[]>;
  sendText(input: {
    conversationId?: string;
    text: string;
    mode?: string;
    // 追加ペイロードは必要に応じて
  }): Promise<{
    conversationId: string;
    messages: IrosMessage[];
  }>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  deleteConversation(conversationId: string): Promise<void>;
  getUserInfo(): Promise<IrosUserInfo | null>;
};
