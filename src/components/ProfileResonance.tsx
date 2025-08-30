// src/components/UserProfile/ProfileResonance.tsx
'use client';

import React from 'react';
import Link from 'next/link';
import type { Profile, ResonanceLog } from './UserProfile'; // or './UserProfile/index'

type Props = {
  profile: Profile;
  routes?: {
    post?: (url: string) => string;          // 元投稿URLをアプリ内に変換したい場合だけ
    qr?: (code: string) => string;           // Qコードページ: 例 `/qcode?user=${code}`
    profileUrl?: (code: string)=> string;    // プロフィール共有URLを自作したい場合
  };
};

const badgeClass = (t: ResonanceLog['type']) =>
  t === 'quote' ? 'badge-quote' : t === 'follow' ? 'badge-follow' : 'badge-echo';

export default function ProfileResonance({ profile, routes }: Props) {
  const logs = Array.isArray(profile.resonance) ? profile.resonance! : [];

  const shareUrl =
    routes?.profileUrl?.(profile.user_code) ??
    `${typeof window !== 'undefined' ? window.location.origin : ''}/profile/${profile.user_code}`;

  const qrHref = routes?.qr?.(profile.user_code) ?? `/qcode?user=${encodeURIComponent(profile.user_code)}`;

  return (
    <>
      <div className="res-head">
        <h3 className="mu-section-title">共鳴履歴</h3>
        <div className="res-actions">
          <Link href={qrHref} className="mu-ghost-btn" aria-label="Qコードでプロフィールを開く">Qコード</Link>
          <button
            className="mu-ghost-btn"
            onClick={() => navigator.clipboard?.writeText(shareUrl)}
            title="プロフィールURLをコピー"
          >
            URLコピー
          </button>
        </div>
      </div>

      {logs.length === 0 ? (
        <div className="mu-muted">まだ共鳴は記録されていません。</div>
      ) : (
        <ul className="res-list">
          {logs.map((r, i) => {
            const when = r.at || '';
            const txt  = r.content || '';
            const link = r.link ? (routes?.post?.(r.link) ?? r.link) : '';

            return (
              <li key={i} className="res-item">
                <span className={`res-badge ${badgeClass(r.type)}`}>
                  {r.type === 'quote' ? '引用' : r.type === 'follow' ? '追従' : '共鳴'}
                </span>

                <div className="res-body">
                  {txt ? <blockquote className="res-quote">{txt}</blockquote> : null}
                  {link ? <a href={link} target="_blank" rel="noreferrer" className="mu-link">元投稿を見る</a> : null}
                  <div className="res-meta mu-muted">
                    {r.by ? <>by <span className="mono">{r.by}</span></> : null}
                    {when ? <> <span className="dot">•</span> {when}</> : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <style jsx>{`
        .res-head{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
        .res-actions{ display:flex; gap:6px; }
        .mu-ghost-btn{
          padding:4px 8px; font-size:12px; border-radius:8px;
          border:1px solid rgba(120,120,180,.2); background:rgba(255,255,255,.6);
        }

        .res-list{ list-style:none; padding:0; margin:0; display:grid; gap:8px; }
        .res-item{
          display:grid; grid-template-columns:auto 1fr; gap:10px; align-items:start;
          background:rgba(255,255,255,.85);
          border:1px solid rgba(120,120,180,.14);
          border-radius:12px; padding:10px 12px;
          box-shadow:0 10px 24px rgba(90,120,255,.08); backdrop-filter:blur(6px);
        }
        .res-badge{
          display:inline-block; font-size:12px; font-weight:700; padding:4px 8px;
          border-radius:999px; border:1px solid transparent; white-space:nowrap;
        }
        .badge-quote{ background:#eff6ff; color:#1e40af; border-color:#bfdbfe; }
        .badge-follow{ background:#ecfdf5; color:#065f46; border-color:#a7f3d0; }
        .badge-echo{ background:#fef3c7; color:#92400e; border-color:#fde68a; }

        .res-body{ display:grid; gap:4px; }
        .res-quote{
          margin:0; padding:8px 10px; border-left:3px solid rgba(100,120,200,.35);
          background:rgba(250,250,255,.7); border-radius:6px;
          font-size:13px; line-height:1.5;
        }
        .res-meta{ font-size:12px; }
        .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
        .dot{ opacity:.6; }
      `}</style>
    </>
  );
}
