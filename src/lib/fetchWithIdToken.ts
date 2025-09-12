// src/lib/fetchWithIdToken.ts
'use client';

import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import { tlog } from '@/lib/telemetry';

/**
 * 初回ロード直後に auth.currentUser が null の場合に備えて待つ。
 * デフォルトは最大 3 秒待機。
 */
function waitForUser(timeoutMs = 3000): Promise<User | null> {
  const auth = getAuth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(getAuth().currentUser ?? null);
    }, timeoutMs);

    const unsub = onAuthStateChanged(auth, (u) => {
      clearTimeout(timer);
      unsub();
      resolve(u ?? null);
    });
  });
}

async function getToken(force = false): Promise<string | null> {
  const auth = getAuth();
  const user = auth.currentUser;
  if (!user) return null;
  try {
    return await user.getIdToken(force);
  } catch {
    return null;
  }
}

export async function fetchWithIdToken(url: string, init: RequestInit = {}) {
  // ① 初回はユーザー復元を少し待つ
  const user = (await waitForUser()) ?? getAuth().currentUser;

  // ② 最初のトークン取得
  let idToken = await getToken(false);

  // ③ ヘッダー構築（元のヘッダーを尊重）
  const headers = new Headers(init.headers || {});
  if (idToken) headers.set('Authorization', `Bearer ${idToken}`);
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json, text/plain, */*');
  }
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const opts: RequestInit = {
    ...init,
    headers,
    credentials: init.credentials ?? 'same-origin',
  };

  const t0 = performance.now();
  let res: Response;

  try {
    res = await fetch(url, opts);
  } catch (e) {
    tlog({
      kind: 'api',
      path: url,
      status: -1,
      latency_ms: Math.round(performance.now() - t0),
      note: 'network error',
      uid: user?.uid ?? null,
      user_code: (user as any)?.user_code ?? null,
    });
    throw e;
  }

  // ④ 401/403 → 強制リフレッシュで 1 回だけ再送
  if ((res.status === 401 || res.status === 403) && user) {
    tlog({
      kind: 'api',
      path: url,
      status: res.status,
      latency_ms: Math.round(performance.now() - t0),
      note: 'auth error (first)',
      uid: user.uid,
      user_code: (user as any)?.user_code ?? null,
    });

    const fresh = await getToken(true);
    if (fresh && fresh !== idToken) {
      const retryHeaders = new Headers(init.headers || {});
      retryHeaders.set('Authorization', `Bearer ${fresh}`);
      if (!retryHeaders.has('Accept')) {
        retryHeaders.set('Accept', 'application/json, text/plain, */*');
      }
      if (!retryHeaders.has('Content-Type') && init.body) {
        retryHeaders.set('Content-Type', 'application/json');
      }

      const retryOpts: RequestInit = {
        ...init,
        headers: retryHeaders,
        credentials: init.credentials ?? 'same-origin',
      };

      const t1 = performance.now();
      const retried = await fetch(url, retryOpts);

      tlog({
        kind: 'api',
        path: url,
        status: retried.status,
        latency_ms: Math.round(performance.now() - t1),
        note: 'auth retry with fresh token',
        uid: user.uid,
        user_code: (user as any)?.user_code ?? null,
      });

      return retried;
    }
  }

  // ⑤ まだ 401/403 なら最終的にログだけ残す
  if (res.status === 401 || res.status === 403) {
    tlog({
      kind: 'api',
      path: url,
      status: res.status,
      latency_ms: Math.round(performance.now() - t0),
      note: 'auth error (final)',
      uid: user?.uid ?? null,
      user_code: (user as any)?.user_code ?? null,
    });
  }

  return res;
}
