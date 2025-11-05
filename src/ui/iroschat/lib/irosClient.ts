// /src/ui/iroschat/lib/irosClient.ts
'use client';

import { getAuth } from 'firebase/auth';

/* ========= Types ========= */
export type Role = 'user' | 'assistant' | 'system';
export type HistoryMsg = { role: Role; content: string };

export type IrosConversation = {
  id: string;
  title: string;
  updated_at?: string | null;
};

export type IrosMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  ts: number; // epoch ms
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;
};

export type UserInfo = {
  id: string;
  name: string;
  userType: string;
  credits: number;
};

/* ========= authFetch ========= */
async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const auth = getAuth();
  const u = auth.currentUser;
  const token = u ? await u.getIdToken(false) : null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };

  const res = await fetch(input, {
    ...init,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return res;
}

/* ========= Conversations ========= */
export async function createConversation(): Promise<{ conversationId: string }> {
  const res = await authFetch('/api/agent/iros/conversations', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', title: '新しい会話' }),
  });
  const j = await res.json();
  const id = String(j?.conversationId || j?.id || '');
  if (!id) throw new Error('createConversation: no conversationId');
  return { conversationId: id };
}

export async function listConversations(): Promise<IrosConversation[]> {
  const res = await authFetch('/api/agent/iros/conversations', { method: 'GET' });
  const j = await res.json();
  const arr = Array.isArray(j?.conversations) ? j.conversations : [];
  return arr.map((r: any) => ({
    id: String(r.id),
    title: (r.title ?? '新規セッション') as string,
    updated_at: (r.updated_at ?? r.created_at ?? null) as string | null,
  }));
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<{ ok: true }> {
  const res = await authFetch('/api/agent/iros/conversations', {
    method: 'POST',
    body: JSON.stringify({ action: 'rename', id: conversationId, title }),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || 'renameConversation failed');
  return { ok: true };
}

export async function deleteConversation(conversationId: string): Promise<{ ok: true }> {
  const res = await authFetch('/api/agent/iros/conversations', {
    method: 'POST',
    body: JSON.stringify({ action: 'delete', id: conversationId }),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || 'deleteConversation failed');
  return { ok: true };
}

/* ========= Messages ========= */
export async function fetchMessages(conversationId: string): Promise<IrosMessage[]> {
  const url = new URL('/api/agent/iros/messages', window.location.origin);
  url.searchParams.set('conversation_id', conversationId);
  const res = await authFetch(url.toString(), { method: 'GET' });
  const j = await res.json();

  const arr = Array.isArray(j?.messages) ? j.messages : [];
  return arr.map((m: any) => {
    const created =
      m?.created_at ? new Date(m.created_at).getTime() : typeof m?.ts === 'number' ? m.ts : Date.now();
    return {
      id: String(m.id),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text: String(m.content ?? m.text ?? ''),
      ts: created,
      q: (m.q ?? m.q_code ?? undefined) as any,
      color: (m.color ?? undefined) as any,
    } satisfies IrosMessage;
  });
}

export async function postMessage(args: {
  conversationId: string;
  text: string;
  role?: 'user' | 'assistant';
}): Promise<{ ok: true }> {
  const res = await authFetch('/api/agent/iros/messages', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: args.conversationId, // API側の期待に合わせる
      text: args.text,
      role: args.role ?? 'user',
    }),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || 'postMessage failed');
  return { ok: true };
}

/* ========= Reply (LLM) ========= */
export async function reply(params: {
  conversationId?: string;
  user_text: string;
  mode?: 'Light' | 'Deep' | 'Harmony' | 'Transcend' | string;
  history?: HistoryMsg[]; // 任意: 直近3件だけ送る
  model?: string;
}): Promise<
  | { ok: boolean; message?: { id?: string; content: string } } // 旧
  | { ok: boolean; assistant?: string; mode?: string; systemPrompt?: string } // 新
> {
  const res = await authFetch('/api/agent/iros/reply', {
    method: 'POST',
    body: JSON.stringify({
      conversationId: params.conversationId, // サーバ未使用でも互換のため送る
      user_text: params.user_text,
      mode: params.mode ?? 'Light',
      history: Array.isArray(params.history) ? params.history.slice(-3) : [],
      model: params.model,
    }),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

/* ========= 保存付き返信 ========= */
export async function replyAndStore(args: {
  conversationId: string;
  user_text: string;
  mode?: string;
  model?: string;
}) {
  const r = await reply(args); // 既存の reply を使用
  const a =
    (r as any)?.message?.content ??
    (r as any)?.assistant ??
    '';
  if (a) {
    await postMessage({ conversationId: args.conversationId, text: a, role: 'assistant' });
  }
  return r;
}

/* ========= User Info ========= */
export async function getUserInfo(): Promise<UserInfo | null> {
  const res = await authFetch('/api/agent/iros/userinfo', { method: 'GET' });
  const j = await res.json();
  if (!j?.ok) return null;
  const u = j.user || null;
  if (!u) return null;
  return {
    id: String(u.id ?? 'me'),
    name: String(u.name ?? 'You'),
    userType: String(u.userType ?? 'member'),
    credits: Number(u.credits ?? 0),
  };
}

/* ========= Default export & window hook ========= */
const api = {
  createConversation,
  listConversations,
  fetchMessages,
  renameConversation,
  deleteConversation,
  postMessage,
  reply,
  replyAndStore, // ← ここに含める
  getUserInfo,
};

export default api;

declare global {
  interface Window {
    irosClient?: typeof api;
  }
}
if (typeof window !== 'undefined') {
  (window as any).irosClient = api;
}
