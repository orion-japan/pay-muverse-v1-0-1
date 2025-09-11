// src/lib/fetchWithIdToken.ts
'use client';

import { getAuth } from 'firebase/auth';
import { tlog } from '@/lib/telemetry';

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
  const auth = getAuth();
  const user = auth.currentUser;

  let idToken = await getToken(false);

  const headers = new Headers(init.headers || {});
  if (idToken) headers.set('Authorization', `Bearer ${idToken}`);
  if (!headers.has('Content-Type') && init.body) {
    headers.set('Content-Type', 'application/json');
  }

  const t0 = performance.now();
  let res: Response;

  try {
    res = await fetch(url, { ...init, headers });
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
      if (!retryHeaders.has('Content-Type') && init.body) {
        retryHeaders.set('Content-Type', 'application/json');
      }

      const t1 = performance.now();
      const retried = await fetch(url, { ...init, headers: retryHeaders });

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
