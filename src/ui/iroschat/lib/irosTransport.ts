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
 * - AbortController でタイムアウトを明示
 * - 401/timeout を区別してログしやすくする
 */
const AUTH_FETCH_TIMEOUT_MS = 60_000; // ★ 必要なら延長（例: 90_000）

async function authFetch(input: RequestInfo | URL, init: RequestInit = {}) {
  // ✅ TDZ/循環importの影響を避けるため、__DEV__ を参照しない
  const DEV = process.env.NODE_ENV !== 'production';

  const headers = new Headers(init.headers || {});
  const credentials = init.credentials ?? 'include';

  // ---- Firebase ID トークン取得（ユーザー準備待ち）----
  const token = await getIdTokenSafe().catch((err) => {
    if (DEV) console.warn('[IROS/API] authFetch getIdTokenSafe error', err);
    throw err;
  });

  headers.set('Authorization', `Bearer ${token}`);

  // JSON 基本
  if (!headers.has('Content-Type') && init.method && init.method !== 'GET') {
    headers.set('Content-Type', 'application/json');
  }

  // ---- timeout ----
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(input, {
      ...init,
      headers,
      credentials,
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!res.ok) {
      const t = await res.text().catch(() => '');
      if (DEV) console.warn('[IROS/API] authFetch error', res.status, t);

      // ★ timeout が body に混ざって 401 になってるケースを識別しやすくする
      if (res.status === 401 && /timeout of 25000ms exceeded/i.test(t)) {
        throw new Error(`HTTP 401 (upstream-timeout) ${t}`);
      }

      throw new Error(`HTTP ${res.status} ${t}`);
    }

    return res;
  } catch (e: any) {
    // AbortError を明示的に timeout 扱い
    if (e?.name === 'AbortError') {
      const msg = `HTTP 408 client_timeout: exceeded ${AUTH_FETCH_TIMEOUT_MS}ms`;
      if (DEV) console.warn('[IROS/API] authFetch abort', { input: String(input), msg });
      throw new Error(msg);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
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
      t = hint ? `はい。${hint} を感じました。🪔` : '';
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

    const text = String(m.content ?? m.text ?? '');

    return {
      id: String(m.id),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      text,
      ts: created,
      meta: m.meta ?? null,
      q: (m.q ?? m.q_code ?? undefined) as any,
      color: (m.color ?? undefined) as any,
    } satisfies IrosMessage;
  });
}


export async function postMessage(args: {
  conversationId: string;
  text: string;
  role?: 'user' | 'assistant';
  meta?: any; // ★ meta をそのまま渡す
  traceId?: string | null; // ✅ 追加：同一リクエスト識別子
}): Promise<{ ok: true }> {
  // ✅ traceId を必ず用意（同一送信の二重POSTをサーバで弾けるように）
  const clientTraceId =
    (args.traceId && String(args.traceId).trim()) ||
    (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
      ? (crypto as any).randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  // ✅ meta.extra.traceId にも入れておく（サーバ側の取り方が揺れても拾える）
  const meta = args.meta ?? null;
  if (meta && typeof meta === 'object') {
    meta.extra = meta.extra ?? {};
    meta.extra.traceId = meta.extra.traceId ?? clientTraceId;
  }

  console.log('[IROS][client] POST /api/agent/iros/messages', {
    conversationId: args.conversationId,
    role: args.role ?? 'user',
    textLen: String(args.text ?? '').length,
    traceId: clientTraceId,
    hasMeta: !!meta,
  });

  const res = await authFetch('/api/agent/iros/messages', {
    method: 'POST',
    body: JSON.stringify({
      conversation_id: args.conversationId,
      text: args.text,
      role: args.role ?? 'user',
      meta, // ★ meta を渡す
      traceId: clientTraceId, // ✅ 本命：サーバが traceId を直で拾えるように
      trace_id: clientTraceId, // ✅ 互換：snake で見てる実装にも当たる
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
  history?: HistoryMsg[]; // 任意（{role, content}）
  model?: string; // 任意
}): Promise<any> {
  // ✅ URL の cid を最優先で拾う（リロード後に別CIDへ飛ばさない）
  const cid =
    params.conversationId ||
    (() => {
      if (typeof window === 'undefined') return '';
      const sp = new URLSearchParams(window.location.search);
      return sp.get('cid') || sp.get('conversationId') || sp.get('conversation_id') || '';
    })() ||
    getCidFromLocation();

  const text = (params.user_text ?? '').toString().trim();
  if (!cid) throw new Error('reply: conversationId is required (body or ?cid)');
  if (!text) throw new Error('reply: text is required');

  // ✅ client traceId を1回だけ確定（/reply でもサーバ生成に頼らない）
  const clientTraceId =
    (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function'
      ? (crypto as any).randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  // ✅ サーバが読むのは body.history（直下）
  const history = Array.isArray(params.history)
    ? params.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant'))
        .slice(-12)
        .map((m) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content : String(m.content ?? ''),
        }))
    : undefined;

  const payload: any = {
    conversationId: cid,
    conversation_id: cid, // ✅ 互換用
    text,
    modeHint: params.mode,
    extra: {
      model: params.model ?? undefined,
      traceId: clientTraceId, // ✅ ここが本命：/reply で traceId を揃える
    },
    ...(history && history.length > 0 ? { history } : {}),
  };

  const userCodeFromUrl =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('user_code') : null;

  const userCodeFromStorage =
    typeof window !== 'undefined' ? window.localStorage.getItem('user_code') : null;

  const userCodeHeader = (userCodeFromUrl || userCodeFromStorage || '').trim() || null;

  console.log('[IROS][client] calling /api/agent/iros/reply', {
    from: 'irosClient.ts',
    conversationId: payload.conversationId,
    clientTraceId,
    textLen: String(payload.text ?? '').length,
    historyLen: Array.isArray(payload.history) ? payload.history.length : 0,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (userCodeHeader) {
    headers['x-user-code'] = userCodeHeader;
  }

  const res = await authFetch('/api/agent/iros/reply', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  // ✅ サーバが付けた traceId をヘッダから回収（あれば優先、なければ clientTraceId）
  const traceIdFromHeader = res.headers.get('x-trace-id') || null;
  const traceId = traceIdFromHeader || clientTraceId;

  const json: any = await res.json().catch(() => ({}));

  // ✅ サーバ返却が assistant/assistantText/content/text など揺れても、UIが必ず拾えるように正規化
  const assistantText =
    (typeof json?.assistant === 'string' && json.assistant) ||
    (typeof json?.assistantText === 'string' && json.assistantText) ||
    (typeof json?.content === 'string' && json.content) ||
    (typeof json?.text === 'string' && json.text) ||
    (typeof json?.reply === 'string' && json.reply) ||
    (typeof json?.message === 'string' && json.message) ||
    '';

  json.assistant = typeof json.assistant === 'string' ? json.assistant : assistantText;
  json.assistantText = typeof json.assistantText === 'string' ? json.assistantText : json.assistant;
  json.content = typeof json.content === 'string' ? json.content : json.assistant;
  json.text = typeof json.text === 'string' ? json.text : json.assistant;

  // ✅ デバッグ用：UIで追えるように返却オブジェクトへ混ぜる（破壊的変更は避ける）
  if (json && typeof json === 'object') {
    json.traceId = json.traceId ?? traceId;
    json.meta = json.meta ?? {};
    json.meta.extra = json.meta.extra ?? {};
    json.meta.extra.traceId = json.meta.extra.traceId ?? traceId;
  }

  console.log('[IROS][client] /reply response', {
    status: res.status,
    clientTraceId,
    traceIdFromHeader,
    traceId,
    hasJson: !!json,
    gate: json?.gate ?? json?.result?.gate ?? null,
    microOnly: json?.meta?.microOnly ?? null,
    mode: json?.mode ?? json?.meta?.mode ?? null,
    finalTextPolicy: json?.meta?.extra?.finalTextPolicy ?? null,
    assistantLen: typeof json?.assistant === 'string' ? json.assistant.length : null,
    assistantHead: typeof json?.assistant === 'string' ? json.assistant.slice(0, 40) : null,
  });

  return json;
}

export async function replyAndStore(args: {
  conversationId: string;
  user_text: string;
  mode?: string;
  model?: string;
  history?: HistoryMsg[];
}) {
  // ① サーバーに返信を依頼（history を渡す）
  const r = await reply({
    conversationId: args.conversationId,
    user_text: args.user_text,
    mode: args.mode,
    model: args.model,
    history: args.history,
  });

  // ② テキスト正規化（[object Object] 対策＋🪔 付与）
  const assistantText = normalizeAssistantText(r);
  const safe = (assistantText ?? '').trim();

  // ③ orchestrator から返ってきた meta を拾う
  const meta = r?.meta ?? null;

  // ★ クライアント側では assistant を DB に二重保存しない ★
  // （保存はサーバ側に任せる）

  return {
    ...r,
    assistant: safe,
    meta,
    saved: true,
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
