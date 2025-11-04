/* eslint-disable */
// src/lib/fetchWithIdToken.ts
'use client';

import { ensureFirebase } from '@/lib/firebaseClient';
import { onAuthStateChanged, type User } from 'firebase/auth';

const DEV = process.env.NODE_ENV !== 'production';
const log = (...a: any[]) => {
  if (DEV) console.log('[fetchWithIdToken]', ...a);
};

/** CSR 専用の安全ガード（SSR のときは素の fetch にフォールバック） */
const isBrowser = typeof window !== 'undefined';

/** 少し待つ */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** ユーザーが現れるのを短時間だけ待つ */
async function waitForUser(timeoutMs = 2000): Promise<User | null> {
  if (!isBrowser) return null;
  const auth = ensureFirebase();
  if (!auth) return null;
  if (auth.currentUser) return auth.currentUser;

  return await new Promise<User | null>((resolve) => {
    const timer = setTimeout(() => resolve(auth.currentUser ?? null), timeoutMs);
    const unsub = onAuthStateChanged(auth, (u) => {
      clearTimeout(timer);
      unsub();
      resolve(u ?? null);
    });
  });
}

/** IdToken を数回リトライで取得（最大 4 回） */
async function getIdTokenWithRetry(maxTry = 4): Promise<string | null> {
  if (!isBrowser) return null;
  const auth = ensureFirebase();
  if (!auth) return null;

  // 既にログイン済みなら即取得
  if (auth.currentUser) {
    try {
      const t = await auth.currentUser.getIdToken();
      if (DEV) log('token from currentUser, len=', t?.length ?? 0);
      return t;
    } catch {
      /* noop */
    }
  }

  for (let i = 0; i < maxTry; i++) {
    const u = await waitForUser(500);
    try {
      const t = await u?.getIdToken();
      if (t) {
        if (DEV) log('acquired idToken len=', t.length, `try=${i + 1}/${maxTry}`);
        return t;
      }
    } catch {
      /* noop */
    }
    if (DEV) log('idToken not ready, retry...', i + 1);
    await sleep(200 + i * 150);
  }

  if (DEV) log('give up acquiring idToken');
  return null;
}

/**
 * fetchWithIdToken
 * - ブラウザ（CSR）では Firebase IdToken を Authorization: Bearer に付与
 * - SSR ではそのまま fetch（サーバAPI側は cookie/ヘッダで検証）
 */
export async function fetchWithIdToken(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  // SSR は何もしない
  if (!isBrowser) return fetch(input, init);

  // headers を組み立て
  const base = new Headers(init.headers as HeadersInit | undefined);

  // Content-Type 自動セット（文字列ボディのみ）
  try {
    if (!base.has('Content-Type') && typeof init.body === 'string') {
      // JSON っぽければ JSON、でなければそのまま
      try {
        JSON.parse(init.body as string);
        base.set('Content-Type', 'application/json');
      } catch {
        /* 既定しない */
      }
    }
  } catch {
    /* noop */
  }

  // IdToken 取得して Authorization 付与
  let hadBearer = false;
  try {
    const idToken = await getIdTokenWithRetry(4);
    if (idToken) {
      base.set('Authorization', `Bearer ${idToken}`);
      hadBearer = true;
      if (DEV) log('attach Authorization Bearer len=', idToken.length);
    } else if (DEV) {
      log('no idToken (not logged in?)');
    }
  } catch (e) {
    if (DEV) log('token error', (e as any)?.message ?? e);
  }

  // --- ここが追加ポイント：開発フォールバック（x-user-code / x-mu-user） ---
  // Bearer が付かない場合でも dev では user_code をヘッダで渡して通す
  if (DEV && !hadBearer) {
    try {
      const fromUrl =
        new URL(window.location.href).searchParams.get('user_code') ||
        new URL(window.location.href).searchParams.get('code');
      const fromStorage =
        window.localStorage.getItem('mu_dev_user_code') ||
        window.localStorage.getItem('DEV_USER_CODE');
      const fallback = fromUrl || fromStorage || '669933';

      if (!base.has('x-user-code')) base.set('x-user-code', fallback);
      if (!base.has('x-mu-user')) base.set('x-mu-user', fallback);

      log('dev-fallback headers attached', { user_code: fallback });
    } catch {
      /* noop */
    }
  }
  // ---------------------------------------------------------------------------

  const finalInit: RequestInit = {
    ...init,
    headers: base,
    credentials: init.credentials ?? 'include', // cookie も送りたい場合
    cache: init.cache ?? 'no-store',
  };

  if (DEV)
    log('FETCH', typeof input === 'string' ? input : (input as URL).toString(), {
      method: finalInit.method ?? 'GET',
    });

  return fetch(input, finalInit);
}

export default fetchWithIdToken;
