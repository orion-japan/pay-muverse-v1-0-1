'use client';
import { getAuth } from 'firebase/auth';
import { sendTelemetry } from '@/lib/telemetry';

export async function fetchWithIdToken(url: string, init: RequestInit = {}) {
  const auth = getAuth();
  const u = auth.currentUser;
  if (!u) throw new Error('Not signed in');

  const makeHeaders = (t: string) => {
    const h = new Headers(init.headers || {});
    h.set('Authorization', `Bearer ${t}`);
    if (!h.has('Content-Type') && init.body) h.set('Content-Type', 'application/json');
    return h;
  };

  // オフライン時は復帰を待つ
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    await new Promise<void>(resolve => {
      const h = () => { window.removeEventListener('online', h); resolve(); };
      window.addEventListener('online', h);
    });
  }

  const t0 = performance.now();
  let token = await u.getIdToken(false);
  let res = await fetch(url, { credentials: 'same-origin', ...init, headers: makeHeaders(token) });
  let latency = Math.round(performance.now() - t0);

  sendTelemetry({ kind: 'api', path: url, status: res.status, latency_ms: latency,
    note: res.ok ? 'ok' : 'fail' });

  if (res.status === 401) {
    const t1 = performance.now();
    token = await u.getIdToken(true); // 強制更新
    const res2 = await fetch(url, { credentials: 'same-origin', ...init, headers: makeHeaders(token) });
    latency = Math.round(performance.now() - t1);

    sendTelemetry({ kind: 'api-retry', path: url, status: res2.status, latency_ms: latency,
      note: res2.ok ? 'ok' : 'fail' });

    res = res2;
  }

  return res;
}
