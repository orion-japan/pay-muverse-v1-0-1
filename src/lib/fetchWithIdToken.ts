// src/lib/fetchWithIdToken.ts（あなたの実装に追記）
import { getAuth } from 'firebase/auth';
import { tlog } from '@/lib/telemetry';

export async function fetchWithIdToken(url: string, init: RequestInit = {}) {
  const auth = getAuth();
  const user = auth.currentUser;
  const idToken = await user?.getIdToken();

  const headers = new Headers(init.headers || {});
  if (idToken) headers.set('Authorization', `Bearer ${idToken}`);
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');

  const t0 = performance.now();
  const res = await fetch(url, { ...init, headers, credentials: 'same-origin' });
  const ms = Math.round(performance.now() - t0);

  if (res.status === 401 || res.status === 403) {
    tlog({
      kind: 'api',
      path: url,
      status: res.status,
      latency_ms: ms,
      note: 'auth error',
      uid: user?.uid ?? null,
      user_code: (user as any)?.user_code ?? null,
    });
  }
  return res;
}
