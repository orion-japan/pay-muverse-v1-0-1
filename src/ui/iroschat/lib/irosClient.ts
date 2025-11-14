// /src/ui/iroschat/lib/irosClient.ts
'use client';

import { getAuth } from 'firebase/auth';

/* ========= Types ========= */
export type Role = 'user' | 'assistant' | 'system';
export type HistoryMsg = { role: Role; content: string };

export type IrosConversation = { id: string; title: string; updated_at?: string | null };

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

/* ========= helper: URLのcid取得 ========= */
function getCidFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('cid');
}

/* ========= ここが今回の核心：応答テキストの正規化 ========= */
// /src/ui/iroschat/lib/irosClient.ts の normalizeAssistantText を丸ごと置換
function normalizeAssistantText(json: any): string {
  // 1) 代表的な場所（★ text / content を最優先で追加）
  let t =
    json?.text ??
    json?.content ??
    json?.assistant ??
    json?.message?.content ??
    json?.choices?.[0]?.message?.content ??
    json?.output_text ??
    '';

  // 2) もしオブジェクトの文字列化が来たら取り直す
  const bad = typeof t === 'string' && /^\[object Object\]$/.test(t);
  if (bad || !t) {
    const a = json?.assistant ?? json?.reply ?? json?.data;
    if (a && typeof a === 'object') {
      t =
        a.text ??
        a.content ??
        a.message ??
        a.output ??
        a.plain ??
        '';
      if (!t) {
        if (Array.isArray(a.content)) {
          t = a.content
            .map((c: any) =>
              typeof c === 'string'
                ? c
                : c?.text ?? c?.content ?? c?.message ?? ''
            )
            .filter(Boolean)
            .join('\n\n');
        } else if (typeof a === 'object') {
          t = JSON.stringify(a, null, 2);
        }
      }
    }
  }

  // 3) まだ空なら debug をヒントに最低限の一文
  if (!t && json?.debug) {
    const d = json.debug;
    const hint = [
      d.phase ? `位相:${d.phase}` : '',
      d.depth ? `深度:${d.depth}` : '',
      d.q ? `Q:${d.q}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
    t = hint ? `はい。${hint} を感じました。🪔` : 'はい。🪔';
  }

  // 4) 最終安全化
  if (typeof t !== 'string') t = String(t ?? '');
  if (/^\[object Object\]$/.test(t)) t = '';

  t = (t ?? '').trim();
  if (t && !/[。！？!?🪔]$/.test(t)) t += '。';
  if (t) {
    t = t.replace(/🪔+/g, '');
    t += '🪔';
  }
  return t;
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
// API期待: { conversationId, text, modeHint?, extra? }
export async function reply(params: {
  conversationId?: string;
  user_text: string;     // ← UI入力
  mode?: string;         // UIのモード文字列（→ modeHintへ）
  history?: HistoryMsg[]; // 任意
  model?: string;         // 任意
}): Promise<any> {
  const cid = params.conversationId ?? getCidFromLocation();
  const text = (params.user_text ?? '').toString().trim();
  if (!cid) throw new Error('reply: conversationId is required (body or ?cid)');
  if (!text) throw new Error('reply: text is required');

  const payload = {
    conversationId: cid,
    text,                        // ← サーバ要求キー
    modeHint: params.mode,       // ← ヒント（任意）
    extra: {
      model: params.model ?? undefined,
      history: Array.isArray(params.history) ? params.history.slice(-3) : undefined,
    },
  };

  const res = await authFetch('/api/agent/iros/reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  return json;
}

/* ========= 保存付き返信（正規化を必ず通す） ========= */
export async function replyAndStore(args: {
  conversationId: string;
  user_text: string;
  mode?: string;
  model?: string;
}) {
  const r = await reply(args);

  // サーバ保存フラグ検知
  const serverPersisted =
    !!(r?.saved || r?.persisted || r?.db_saved || r?.message_id || r?.messageId);

  const assistantText = normalizeAssistantText(r);
  const safe = assistantText || 'はい。🪔';

  // サーバ未保存なら、クライアントで保存
  if (!serverPersisted) {
    await postMessage({
      conversationId: args.conversationId,
      text: safe,
      role: 'assistant',
    });
  }

  return { ...r, assistant: safe, saved: serverPersisted || undefined };
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
  replyAndStore,
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
