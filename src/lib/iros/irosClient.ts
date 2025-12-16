// src/lib/iros/irosClient.ts
// 役割: すべての Iros API 呼び出しに Bearer を付与しつつ、reply では
// URL ?cid=... を conversationId のフォールバックとして自動適用する。

import { getAuth, User } from 'firebase/auth';

type Json = Record<string, any>;

/**
 * Firebase Auth の currentUser が有効になるまで待つ。
 * 最大 timeoutMs ミリ秒待って、それでもいなければ null を返す。
 */
async function waitForCurrentUser(timeoutMs = 3000): Promise<User | null> {
  const auth = getAuth();
  const start = Date.now();

  // すでに取得済みならそのまま返す
  if (auth.currentUser) return auth.currentUser;

  while (!auth.currentUser && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 50));
  }

  return auth.currentUser ?? null;
}

/**
 * 認証付き fetch
 * - currentUser が準備できるまで待機
 * - user が取れない場合はサーバに投げずにエラーを投げる（401 を出さない）
 */
async function withAuthFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers || {});
  const cred: RequestCredentials = init.credentials ?? 'include';

  // ---- Firebase currentUser を待つ ----
  const user = await waitForCurrentUser();

  if (!user) {
    // サーバに投げず、クライアント側で「未認証」として扱う
    throw new Error('not_authenticated: firebase currentUser is null');
  }

  // ---- ID トークン取得（強制リフレッシュ）----
  const token = await user.getIdToken(true).catch(() => null);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // JSON 基本
  if (!headers.has('content-type') && init.method && init.method !== 'GET') {
    headers.set('content-type', 'application/json');
  }

  let res = await fetch(path, { ...init, headers, credentials: cred });

  // 普通はここで終了
  if (res.status !== 401) return res;

  // ---- 401 の場合のみ、念のためもう一度リフレッシュして再試行 ----
  const fresh = await user.getIdToken(true).catch(() => null);
  if (fresh) {
    headers.set('Authorization', `Bearer ${fresh}`);
    res = await fetch(path, { ...init, headers, credentials: cred });
  }

  return res;
}

function getCidFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  const sp = new URLSearchParams(window.location.search);
  return sp.get('cid');
}

// -------- 公開 API --------

export async function irosReply(body: {
  conversationId?: string;
  text?: string;
  modeHint?: string;
  extra?: Json;

  // ✅追加
  history?: unknown[];
}): Promise<Json> {
  const cid = body.conversationId ?? getCidFromLocation();
  const text = (body.text ?? '').toString().trim();

  if (!cid) throw new Error('conversationId is required (no body.conversationId and no ?cid in URL)');
  if (!text) throw new Error('text is required');

  const payload = {
    conversationId: cid,
    text,
    modeHint: body.modeHint,
    extra: body.extra,

    // ✅追加
    history: Array.isArray(body.history) ? body.history : undefined,
  };

  const res = await withAuthFetch('/api/agent/iros/reply', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`reply failed: ${res.status} ${msg}`);
  }
  return res.json();
}


/**
 * Remember バンドル一覧を取得する（認証付き）
 * GET /api/agent/iros/remember/bundles
 */
export async function irosRememberBundles(params?: {
  period?: 'day' | 'week' | 'month';
  limit?: number;
  tenantId?: string;
}): Promise<Json> {
  const period = params?.period ?? 'month';
  const limit = params?.limit ?? 30;
  const tenantId = params?.tenantId;

  const qs = new URLSearchParams();
  qs.set('period', period);
  qs.set('limit', String(limit));
  if (tenantId) qs.set('tenant_id', tenantId);

  const res = await withAuthFetch(`/api/agent/iros/remember/bundles?${qs.toString()}`, {
    method: 'GET',
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`remember bundles failed: ${res.status} ${msg}`);
  }

  return res.json();
}
