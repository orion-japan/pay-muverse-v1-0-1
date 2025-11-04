// src/lib/mu/retrieveKnowledge.ts
export async function muRetrieveKnowledge(q: string, limit = 4) {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const url = new URL(`${base}/api/knowledge/search`);
  url.searchParams.set('q', (q ?? '').trim());

  const t0 = Date.now();
  try {
    const res = await fetch(url.toString(), { cache: 'no-store' });
    const ms = Date.now() - t0;
    if (!res.ok) {
      console.warn('[mu.kb] search NG', { q, status: res.status, ms });
      return { items: [], log: { q, url: url.toString(), status: res.status, ms } };
    }
    const json = await res.json();
    const items = (json?.items ?? []).slice(0, limit);
    console.log('[mu.kb] search OK', { q, count: items.length, ms });
    return { items, log: { q, url: url.toString(), status: res.status, ms } };
  } catch (e: any) {
    const ms = Date.now() - t0;
    console.error('[mu.kb] search ERR', { q, err: e?.message, ms });
    return { items: [], log: { q, url: url.toString(), err: e?.message, ms } };
  }
}
