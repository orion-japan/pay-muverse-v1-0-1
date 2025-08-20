'use client';

import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@supabase/supabase-js';

type Totals = { like: number; heart: number; smile: number; wow: number; share: number };
type Summary = {
  ok: boolean;
  user_code: string;
  received: Totals;
  given: Totals;
  totals: { received: number; given: number };
  message?: string;
};

const Z: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };

const hasRealtimeEnv =
  typeof process !== 'undefined' &&
  !!process.env.NEXT_PUBLIC_SUPABASE_URL &&
  !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const sb = hasRealtimeEnv
  ? createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  : null;

export default function MyReactionsCard({ userCode }: { userCode?: string | null }) {
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const normalize = (j: any, fallbackCode: string): Summary => {
    const safe = (x: any): Totals => ({
      like: Number(x?.like ?? 0),
      heart: Number(x?.heart ?? 0),
      smile: Number(x?.smile ?? 0),
      wow: Number(x?.wow ?? 0),
      share: Number(x?.share ?? 0),
    });
    const r = safe(j?.received ?? {});
    const g = safe(j?.given ?? {});
    return {
      ok: !!j?.ok,
      user_code: String(j?.user_code ?? fallbackCode ?? ''),
      received: r,
      given: g,
      totals: {
        received: Number(j?.totals?.received ?? Object.values(r).reduce((a, b) => a + b, 0)),
        given: Number(j?.totals?.given ?? Object.values(g).reduce((a, b) => a + b, 0)),
      },
      message: j?.message,
    };
  };

  const load = useCallback(
    async (code?: string) => {
      const u = code ?? userCode ?? '';
      if (!u) return;
      setLoading(true);
      setErr(null);
      try {
        const res = await fetch(`/api/reactions/summary?user_code=${encodeURIComponent(u)}`, {
          cache: 'no-store',
        });
        const json = await res.json().catch(() => ({}));
        setData(normalize(json, u));
        if (!res.ok || json?.ok === false) setErr(json?.message ?? `failed (${res.status})`);
      } catch (e: any) {
        setErr(e?.message ?? 'unknown error');
        setData({
          ok: false,
          user_code: u,
          received: { ...Z },
          given: { ...Z },
          totals: { received: 0, given: 0 },
        });
      } finally {
        setLoading(false);
      }
    },
    [userCode]
  );

  // 初回：userCode が確定するまで待つ。未確定時は localStorage を試す。
  useEffect(() => {
    if (userCode) {
      load(userCode);
      return;
    }
    try {
      const lc = localStorage.getItem('user_code');
      if (lc) load(lc);
    } catch {}
  }, [userCode, load]);

  // Realtime（反応が入ったら再取得）
  useEffect(() => {
    if (!sb) return;
    const u = userCode || (() => {
      try { return localStorage.getItem('user_code') || ''; } catch { return ''; }
    })();
    if (!u) return;

    const chan = sb
      .channel(`rx-summary-${u}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, () => {
        load(u);
      })
      .subscribe();

    return () => { sb.removeChannel(chan); };
  }, [userCode, load]);

  // 任意：外部から明示リロードを受け付け（トグル後に発火させてもOK）
  useEffect(() => {
    const h = () => {
      const u = userCode || (() => { try { return localStorage.getItem('user_code') || ''; } catch { return ''; } })();
      if (u) load(u);
    };
    window.addEventListener('reactions:refresh-summary', h);
    return () => window.removeEventListener('reactions:refresh-summary', h);
  }, [userCode, load]);

  const received = data?.received ?? Z;
  const given = data?.given ?? Z;
  const totals = data?.totals ?? { received: 0, given: 0 };

  return (
    <section className="profile-card">
      <h2 className="profile-section-title" style={{ marginTop: 0, marginBottom: 8 }}>
        リアクション集計
      </h2>

      {loading && <div>読み込み中…</div>}
      {!loading && err && <div style={{ color: '#c00', fontSize: 12, marginBottom: 8 }}>{err}</div>}

      {!loading && (
        <div className="space-y-2">
          <div><strong>受け取り合計</strong>: {totals.received}</div>
          <div>👍 {received.like}　❤️ {received.heart}　😊 {received.smile}　😮 {received.wow}　🔁 {received.share}</div>
          <hr className="my-2" />
          <div><strong>自分が押した</strong>: {totals.given}</div>
          <div>👍 {given.like}　❤️ {given.heart}　😊 {given.smile}　😮 {given.wow}　🔁 {given.share}</div>

          <button className="btn btn-sm mt-2" onClick={() => load()}>
            再読み込み
          </button>
        </div>
      )}
    </section>
  );
}
