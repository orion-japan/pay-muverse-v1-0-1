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

  useEffect(() => {
    if (userCode) { load(userCode); return; }
    try {
      const lc = localStorage.getItem('user_code');
      if (lc) load(lc);
    } catch {}
  }, [userCode, load]);

  useEffect(() => {
    if (!sb) return;
    const u = userCode || (() => { try { return localStorage.getItem('user_code') || ''; } catch { return ''; } })();
    if (!u) return;

    const chan = sb
      .channel(`rx-summary-${u}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reactions' }, () => load(u))
      .subscribe();

    return () => { sb.removeChannel(chan); };
  }, [userCode, load]);

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
    <>
      {/* ヘッダー（表題は親で出すのでサブ情報のみ） */}
      <div className="rx-head">
        <div className="rx-sub">最新の集計</div>
        <button className="mu-ghost-btn" onClick={() => load()} aria-label="再読み込み">再読み込み</button>
      </div>

      {loading && <div className="mu-muted">読み込み中…</div>}
      {!loading && err && <div className="rx-error">{err}</div>}

      {!loading && (
        <div className="rx-grid">
          {/* 受取 */}
          <div className="rx-card">
            <div className="rx-title">受け取った</div>
            <div className="rx-total">{totals.received}</div>
            <ul className="rx-list">
  <li><span className="rx-emoji">👍</span><span className="rx-label">いいね</span><span className="rx-val">{received.like}</span></li>
  <li><span className="rx-emoji">❤️</span><span className="rx-label">ハート</span><span className="rx-val">{received.heart}</span></li>
  <li><span className="rx-emoji">😊</span><span className="rx-label">スマイル</span><span className="rx-val">{received.smile}</span></li>
  <li><span className="rx-emoji">😮</span><span className="rx-label">ワオ</span><span className="rx-val">{received.wow}</span></li>
  <li><span className="rx-emoji">🔁</span><span className="rx-label">共鳴</span><span className="rx-val">{received.share}</span></li>
</ul>
          </div>

          {/* 送付（自分が押した） */}
          <div className="rx-card">
            <div className="rx-title">自分が押した</div>
            <div className="rx-total">{totals.given}</div>
            <ul className="rx-list">
              <li><span className="rx-emoji">👍</span><span className="rx-label">Like</span><span className="rx-val">{given.like}</span></li>
              <li><span className="rx-emoji">❤️</span><span className="rx-label">Heart</span><span className="rx-val">{given.heart}</span></li>
              <li><span className="rx-emoji">😊</span><span className="rx-label">Smile</span><span className="rx-val">{given.smile}</span></li>
              <li><span className="rx-emoji">😮</span><span className="rx-label">Wow</span><span className="rx-val">{given.wow}</span></li>
              <li><span className="rx-emoji">🔁</span><span className="rx-label">Resonance</span><span className="rx-val">{given.share}</span></li>
            </ul>
          </div>
        </div>
      )}

      <style jsx>{`
        .rx-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
        .rx-sub{ font-size:12px; color:#6b7280; }
        .mu-ghost-btn{
          padding:4px 8px; font-size:12px; border-radius:8px;
          border:1px solid rgba(120,120,180,.2); background:rgba(255,255,255,.6);
        }
        .rx-error{ color:#c00; font-size:12px; margin-bottom:8px; }

        .rx-grid{
          display:grid; gap:10px;
          grid-template-columns:1fr 1fr;
        }
        @media(max-width:520px){ .rx-grid{ grid-template-columns:1fr; } }

        .rx-card{
          background:rgba(255,255,255,.85);
          border:1px solid rgba(120,120,180,.14);
          border-radius:12px;
          padding:10px 12px;
          box-shadow:0 10px 24px rgba(90,120,255,.08);
          backdrop-filter: blur(6px);
        }
        .rx-title{ font-size:13px; color:#111827; opacity:.85; }
        .rx-total{
          font-size:22px; font-weight:800; margin:4px 0 8px;
          letter-spacing:.2px;
        }
        .rx-list{ list-style:none; padding:0; margin:0; display:grid; gap:6px; }
        .rx-list li{
          display:grid; grid-template-columns:20px 1fr auto; align-items:center;
          font-size:14px;
        }
        .rx-emoji{ width:20px; text-align:center; }
        .rx-label{ color:#374151; }
        .rx-val{
          font-weight:700; padding:2px 8px; border-radius:9999px;
          background:#f3f4f6; border:1px solid #e5e7eb; min-width:2.5rem; text-align:right;
        }

        .mu-muted{ color:#6b7280; font-size:13px; }
      `}</style>
    </>
  );
}
