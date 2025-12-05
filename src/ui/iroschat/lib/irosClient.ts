// /src/ui/iroschat/lib/irosClient.ts
'use client';

import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';

const __DEV__ = process.env.NODE_ENV !== 'production';

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
  meta?: any; // ★ 追加
};

export type UserInfo = {
  id: string;
  name: string;
  userType: string;
  credits: number;
};

/* ========= Firebase ID トークン取得（ユーザー準備待ち） ========= */

async function getIdTokenSafe(timeoutMs = 5000): Promise<string> {
  const auth = getAuth();

  // すでにログイン済みならそれを使う
  if (auth.currentUser) {
    return auth.currentUser.getIdToken();
  }

  // まだなら onAuthStateChanged で 1 回だけ待つ
  return new Promise<string>((resolve, reject) => {
    let done = false;

    const unsubscribe = onAuthStateChanged(
      auth,
      async (user: User | null) => {
        if (done) return;
        done = true;
        unsubscribe();

        if (!user) {
          const err = new Error(
            '401 not_authenticated: firebase currentUser is null (onAuthStateChanged)',
          );
          if (__DEV__) {
            console.warn('[IROS/API] getIdTokenSafe no user', err.message);
          }
          reject(err);
          return;
        }

        try {
          const token = await user.getIdToken();
          resolve(token);
        } catch (e) {
          reject(e);
        }
      },
      (error) => {
        if (done) return;
        done = true;
        unsubscribe();
        reject(error);
      },
    );

    // タイムアウト保険
    setTimeout(async () => {
      if (done) return;
      done = true;
      unsubscribe();

      const user = auth.currentUser;
      if (!user) {
        const err = new Error(
          '401 not_authenticated: firebase currentUser is null (timeout)',
        );
        if (__DEV__) {
          console.warn('[IROS/API] getIdTokenSafe timeout', err.message);
        }
        reject(err);
        return;
      }

      try {
        const token = await user.getIdToken();
        resolve(token);
      } catch (e) {
        reject(e);
      }
    }, timeoutMs);
  });
}

/* ========= authFetch ========= */
/**
 * 認証付き fetch
 * - Firebase ID トークンが取れるまで待機
 * - 401 系は Error として投げるが、TypeError("Failed to fetch") は基本的にネットワークエラーのみ
 * - 呼び出し側は `/api/...` の相対パス指定でOK
 */
async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  const headers = new Headers(init.headers || {});
  const credentials = init.credentials ?? 'include';

  // ---- Firebase ID トークン取得（ユーザー準備待ち）----
  const token = await getIdTokenSafe().catch((err) => {
    if (__DEV__) console.warn('[IROS/API] authFetch getIdTokenSafe error', err);
    throw err;
  });

  headers.set('Authorization', `Bearer ${token}`);

  // JSON 基本
  if (!headers.has('Content-Type') && init.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(input, {
    ...init,
    headers,
    credentials,
    cache: 'no-store',
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (__DEV__) console.warn('[IROS/API] authFetch error', res.status, t);
    throw new Error(`HTTP ${res.status} ${t}`);
  }
  return res;
}

/* ========= helper: URL の cid 取得 ========= */
function getCidFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('cid');
}

/* ========= 応答テキストの正規化 ========= */
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

  // 2) [object Object] になってしまった場合の救済
  const bad = typeof t === 'string' && /^\[object Object\]$/.test(t);
  if (bad || !t) {
    const a = json?.assistant ?? json?.reply ?? json?.data;
    if (a && typeof a === 'object') {
      t =
        (a as any).text ??
        (a as any).content ??
        (a as any).message ??
        (a as any).output ??
        (a as any).plain ??
        '';

      if (!t) {
        if (Array.isArray((a as any).content)) {
          t = (a as any).content
            .map((c: any) =>
              typeof c === 'string'
                ? c
                : c?.text ?? c?.content ?? c?.message ?? '',
            )
            .filter(Boolean)
            .join('\n\n');
        } else if (typeof a === 'object') {
          t = JSON.stringify(a, null, 2);
        }
      }
    }
  }

  // 3) まだ空なら debug から最低限の一文を作る
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
  try {
    const res = await authFetch('/api/agent/iros/conversations', { method: 'GET' });
    const j = await res.json();
    const arr = Array.isArray(j?.conversations) ? j.conversations : [];
    return arr.map((r: any) => ({
      id: String(r.id),
      title: (r.title ?? '新規セッション') as string,
      updated_at: (r.updated_at ?? r.created_at ?? null) as string | null,
    }));
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    // 未ログインまたは currentUser なしの場合は「会話なし」として扱う
    if (msg.includes('401 not_authenticated') || msg.includes('HTTP 401')) {
      if (__DEV__) console.info('[IrosClient] listConversations unauthenticated → []');
      return [];
    }
    console.error('[IrosClient] listConversations error:', e);
    return [];
  }
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
  const params = new URLSearchParams({ conversation_id: conversationId });
  const res = await authFetch(`/api/agent/iros/messages?${params.toString()}`, {
    method: 'GET',
  });
  const j = await res.json();

  const arr = Array.isArray(j?.messages) ? j.messages : [];
  return arr.map((m: any) => {
    const created = m?.created_at
      ? new Date(m.created_at).getTime()
      : typeof m?.ts === 'number'
      ? m.ts
      : Date.now();
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
  meta?: any; // ★ 追加
}): Promise<{ ok: true }> {
  const res = await authFetch('/api/agent/iros/messages', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: args.conversationId,
      text: args.text,
      role: args.role ?? 'user',
      meta: args.meta ?? null, // ★ 追加：サーバに meta を渡す
    }),
  });
  const j = await res.json();
  if (!j?.ok) throw new Error(j?.error || 'postMessage failed');
  return { ok: true };
}

/* ========= Reply (LLM) ========= */
export async function reply(params: {
  conversationId?: string;
  user_text: string; // UI 入力
  mode?: string; // UI のモード文字列（→ modeHint へ）
  history?: HistoryMsg[]; // 任意
  model?: string; // 任意
}): Promise<any> {
  const cid = params.conversationId ?? getCidFromLocation();
  const text = (params.user_text ?? '').toString().trim();
  if (!cid) throw new Error('reply: conversationId is required (body or ?cid)');
  if (!text) throw new Error('reply: text is required');

  const payload = {
    conversationId: cid,
    text, // サーバ要求キー
    modeHint: params.mode,
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

// src/ui/iroschat/lib/irosClient.ts 内の replyAndStore をこの形に置き換え

export async function replyAndStore(args: {
  conversationId: string;
  user_text: string;
  mode?: string;
  model?: string;
}) {
  // ① サーバーに返信を依頼
  const r = await reply(args);

  // ② テキスト正規化（[object Object] 対策＋🪔 付与）
  const assistantText = normalizeAssistantText(r);
  const safe = assistantText || 'はい。🪔';

  // ③ orchestrator から返ってきた meta を拾う
  const meta = r?.meta ?? null;

  // ★ ここでは DB には一切保存しない ★
  // （assistant の保存はサーバー側 / orchestrator に任せる）
  // → これで「assistant が2行入る」現象が止まります。

  // 呼び出し側（IrosChatContext）で使うために、
  // assistant と meta だけ整えて返す
  return {
    ...r,
    assistant: safe,
    meta,
    saved: true, // フラグだけ true にしておく（実際の保存はサーバー側）
  };
}


/* ========= User Info ========= */
export async function getUserInfo(): Promise<UserInfo | null> {
  try {
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
  } catch (e: any) {
    const msg = String(e?.message ?? '');
    // ★ 401（未ログイン or currentUser=null）は「ユーザー情報なし」として扱う
    if (msg.includes('401 not_authenticated') || msg.includes('HTTP 401')) {
      if (__DEV__) console.info('[IrosClient] getUserInfo: unauthenticated → null');
      return null;
    }

    console.error('[IrosClient] getUserInfo error:', e);
    return null;
  }
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
