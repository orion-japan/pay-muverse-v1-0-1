'use client';

import React from 'react';
import type { Profile } from './UserProfile';

type Props = {
  profile: Profile;
};

/** プレーンテキスト内の URL をアンカーに変換（超軽量版） */
function linkify(text?: string) {
  if (!text) return '—';
  const parts = text.split(/(https?:\/\/[^\s、，]+)|(\bwww\.[^\s、，]+)\b/g);
  return parts
    .filter(Boolean)
    .map((p, i) => {
      if (!p) return null;
      const url =
        /^https?:\/\//i.test(p) ? p :
        /^www\./i.test(p) ? `https://${p}` : null;
      return url ? (
        <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="auto-link">
          {p}
        </a>
      ) : (
        <span key={i}>{p}</span>
      );
    });
}

/** 項目を丸ごとリンク化（値が URLっぽい時） */
function renderItem(value?: string) {
  if (!value) return <span>—</span>;
  const trimmed = value.trim();
  if (/^(https?:\/\/|www\.)/i.test(trimmed)) {
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className="auto-link">
        {trimmed}
      </a>
    );
  }
  return <span>{linkify(trimmed)}</span>;
}

export default function ProfileSNS({ profile }: Props) {
  const {
    x_handle,
    instagram,
    facebook,
    linkedin,
    youtube,
    website_url,
  } = profile;

  return (
    <section className="profile-card">
      <header className="profile-card__title">
        <span className="dot" />
        SNS / Link
      </header>

      <div className="profile-sns__list">
        <div className="sns-row">
          <div className="sns-label">X (Twitter)</div>
          <div className="sns-value">{renderItem(x_handle)}</div>
        </div>
        <div className="sns-row">
          <div className="sns-label">Instagram</div>
          <div className="sns-value">{renderItem(instagram)}</div>
        </div>
        <div className="sns-row">
          <div className="sns-label">Facebook</div>
          <div className="sns-value">{renderItem(facebook)}</div>
        </div>
        <div className="sns-row">
          <div className="sns-label">LinkedIn</div>
          <div className="sns-value">{renderItem(linkedin)}</div>
        </div>
        <div className="sns-row">
          <div className="sns-label">YouTube</div>
          <div className="sns-value">{renderItem(youtube)}</div>
        </div>
        <div className="sns-row">
          <div className="sns-label">Webサイト</div>
          <div className="sns-value">{renderItem(website_url)}</div>
        </div>
      </div>
    </section>
  );
}
