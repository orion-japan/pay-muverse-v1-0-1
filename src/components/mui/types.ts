// src/components/mui/types.ts
export type ChatRole = 'user' | 'assistant';
export type Msg = { role: ChatRole; content: string };

export type MuiApiOk = {
  ok: true;
  reply: string;
  conversation_code?: string | null;
  balance?: number | null;
};

export type MuiApiNg = { ok: false; error: string };

export type MuiApiRes = MuiApiOk | MuiApiNg | Record<string, any>;
