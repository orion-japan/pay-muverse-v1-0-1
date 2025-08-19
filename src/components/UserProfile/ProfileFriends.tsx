// src/components/UserProfile/ProfileFriends.tsx
'use client';

import React, { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type SummaryRow = { pair: string; cnt: number };
type DetailRow = {
  user_code: string;
  display_name: string | null; // OFF の人は null
  avatar_url: string | null;
  from_me: 'F'|'R'|'C'|'I';
  to_me: 'F'|'R'|'C'|'I';
};

type Props = { profile: { user_code: string } };

const pairClass = (pair: string) => {
  if (pair === 'FF') return 'pair-badge ff';
  if (pair === 'FR' || pair === 'RF') return 'pair-badge fr';
  if (pair === 'RR') return 'pair-badge rr';
  return 'pair-badge other';
};

export default function ProfileFriends({ profile }: Props) {
  const [summary, setSummary] = useState<SummaryRow[] | null>(null);
  const [details, setDetails] = useState<DetailRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [isPaid, setIsPaid] = useState<boolean>(false);

  useEffect(() => {
    let aborted = false;

    (async () => {
      try {
        setLoading(true);
        const auth = getAuth();
        const user = auth.currentUser;
        const token = user ? await user.getIdToken(true) : null;

        const res = await fetch(`/api/shipmates?owner=${encodeURIComponent(profile.user_code)}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });

        if (!res.ok) throw new Error(await res.text().catch(() => ''));

        // 課金ユーザーには配列、free には {summary:[...]}
        const j = await res.json();

        if (Array.isArray(j)) {
          if (!aborted) {
            setIsPaid(true);
            setDetails(j as DetailRow[]);
            setSummary(null);
          }
        } else {
          if (!aborted) {
            setIsPaid(false);
            setSummary((j.summary || []) as SummaryRow[]);
            setDetails(null);
          }
        }
      } catch {
        if (!aborted) { setSummary([]); setDetails([]); }
      } finally {
        if (!aborted) setLoading(false);
      }
    })();

    return () => { aborted = true; };
  }, [profile.user_code]);

  return (
    <div>
      <div className="profile-section-title">シップメイト</div>

      {loading && <div className="muted">読み込み中…</div>}

      {!loading && !isPaid && summary && (
        <div className="summary-grid">
          {summary.length === 0 && <div className="muted">両想いの相手はいません。</div>}
          {summary.map((s) => (
            <div key={s.pair} className="summary-card">
              <span className={pairClass(s.pair)}>{s.pair}</span>
              <div className="summary-num">{s.cnt}</div>
            </div>
          ))}
        </div>
      )}

      {!loading && isPaid && details && (
        <>
          {details.length === 0 && <div className="muted">両想いの相手はいません。</div>}
          <ul className="shipmates-list">
            {details.map((m) => {
              const pair = `${m.from_me}${m.to_me}`;
              const displayName = m.display_name ?? '匿名さん';
              const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
              const avatar =
                m.avatar_url && /^https?:\/\//i.test(m.avatar_url)
                  ? m.avatar_url
                  : m.avatar_url
                  ? `${base}/storage/v1/object/public/avatars/${m.avatar_url}`
                  : '';

              return (
                <li key={m.user_code} className="shipmate-item">
                  <div className="shipmate-left">
                    {avatar ? <img className="shipmate-avatar" src={avatar} alt="" /> : <div className="shipmate-avatar placeholder" />}
                    <div className="shipmate-meta">
                      <div className="shipmate-name">{displayName}</div>
                      <div className="shipmate-code">Code: {m.user_code}</div>
                    </div>
                  </div>
                  <div className="shipmate-right">
                    <span className={pairClass(pair)}>{pair}</span>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <style jsx>{`
        .muted { color:#6b7280; font-size:13px; }
        .summary-grid { display:grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap:8px; }
        .summary-card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:12px; text-align:center; }
        .summary-num { font-size:20px; font-weight:800; margin-top:6px; }
        .shipmates-list { list-style:none; padding:0; margin:0; display:grid; gap:8px; }
        .shipmate-item { border:1px solid #e5e7eb; border-radius:10px; padding:10px 12px; display:flex; align-items:center; justify-content:space-between; background:#fff; }
        .shipmate-left { display:flex; gap:10px; align-items:center; }
        .shipmate-avatar { width:36px; height:36px; border-radius:9999px; object-fit:cover; }
        .shipmate-avatar.placeholder { background:#f3f4f6; }
        .shipmate-meta { display:grid; }
        .shipmate-name { font-weight:600; }
        .shipmate-code { font-size:12px; color:#6b7280; }
        .pair-badge { display:inline-block; min-width:38px; text-align:center; font-weight:700; font-size:12px; padding:4px 8px; border-radius:9999px; letter-spacing:.5px; border:1px solid transparent; }
        .pair-badge.ff { background:#ecfdf5; color:#065f46; border-color:#a7f3d0; }
        .pair-badge.fr { background:#eff6ff; color:#1e40af; border-color:#bfdbfe; }
        .pair-badge.rr { background:#fef3c7; color:#92400e; border-color:#fde68a; }
        .pair-badge.other { background:#f3f4f6; color:#374151; border-color:#e5e7eb; }
        @media (max-width:540px){ .summary-grid{ grid-template-columns:1fr 1fr; } }
      `}</style>
    </div>
  );
}
