// src/lib/iros/irosClient.ts
// 役割: すべての Iros API 呼び出しに Bearer を付与しつつ、reply では
// URL ?cid=... を conversationId のフォールバックとして自動適用する。

import { getAuth } from 'firebase/auth';

type Json = Record<string, any>;

async function withAuthFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const auth = getAuth();
  const headers = new Headers(init.headers || {});
  const cred: RequestCredentials = init.credentials ?? 'include';

  // まずはキャッシュされた ID トークン
  const cached = await auth.currentUser?.getIdToken(false).catch(() => null);
  if (cached) headers.set('Authorization', `Bearer ${cached}`);

  // JSON 基本
  if (!headers.has('content-type') && init.method && init.method !== 'GET') {
    headers.set('content-type', 'application/json');
  }

  let res = await fetch(path, { ...init, headers, credentials: cred });
  if (res.status !== 401) return res;

  // 401 の場合のみ強制リフレッシュで 1 回再試行
  const fresh = await auth.currentUser?.getIdToken(true).catch(() => null);
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
}): Promise<Json> {
  const cid = body.conversationId ?? getCidFromLocation();
  const text = (body.text ?? '').toString().trim();

  if (!cid) {
    throw new Error('conversationId is required (no body.conversationId and no ?cid in URL)');
  }
  if (!text) {
    throw new Error('text is required');
  }

  const payload = {
    conversationId: cid,
    text,
    modeHint: body.modeHint,
    extra: body.extra,
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

export async function irosConversations(): Promise<Json> {
  const res = await withAuthFetch('/api/agent/iros/conversations', { method: 'GET' });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`conversations failed: ${res.status} ${msg}`);
  }
  return res.json();
}

export async function irosUserInfo(): Promise<Json> {
  const res = await withAuthFetch('/api/agent/iros/userinfo', { method: 'GET' });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`userinfo failed: ${res.status} ${msg}`);
  }
  return res.json();
}
