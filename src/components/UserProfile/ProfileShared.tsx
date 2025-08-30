'use client';

import React from 'react';
import type { Profile } from './index'; // ← 修正ポイント

type Props = { profile: Profile };

/**
 * shared の想定形（現状データ無しでもOK）:
 * [{ title: string; link?: string; by?: string; at?: string }]
 */
export default function ProfileShared({ profile }: Props) {
  const shared: any[] = Array.isArray((profile as any)?.shared)
    ? (profile as any).shared
    : [];

  // 親(UserProfile)が <section class="profile-card"> で包むので、
  // ここでは“中身のみ”を描画する
  return (
    <>
      <h3 className="mu-section-title">シェア情報</h3>

      {shared.length === 0 ? (
        <div className="mu-muted">シェアされた情報はまだありません</div>
      ) : (
        <ul className="shared-list">
          {shared.map((s, i) => (
            <li key={i} className="shared-item">
              {s?.link ? (
                <a href={s.link} className="mu-link" target="_blank" rel="noreferrer">
                  {s?.title || s?.link}
                </a>
              ) : (
                <span className="mono">{s?.title || 'Untitled'}</span>
              )}
              {(s?.by || s?.at) ? (
                <span className="mu-muted small">
                  {s?.by ? ` by ${s.by}` : ''}{s?.at ? ` • ${s.at}` : ''}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <style jsx>{`
        .shared-list{ list-style:none; padding:0; margin:0; display:grid; gap:8px; }
        .shared-item{ display:flex; gap:6px; align-items:center; }
        .mu-section-title{ margin:0 0 8px; font-size:14px; opacity:.9; }
        .mu-muted{ color:#6b7280; font-size:13px; }
        .small{ font-size:12px; }
        .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      `}</style>
    </>
  );
}
