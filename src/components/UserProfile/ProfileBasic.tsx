'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import type { Profile } from './UserProfile';

type Props = {
  profile: Profile;
};

export default function ProfileBasic({ profile }: Props) {
  const {
    user_code,
    name,
    birthday,
    prefecture,
    city,
    avatar_url,
  } = profile;

  const router = useRouter();
  const goEdit = () => router.push('/mypage/create');

  return (
    <section className="profile-card profile-basic">
      <header className="profile-card__title">
        <span className="dot" />
        基本情報

        {/* 右側アクション（コード表示 + 修正ボタン） */}
        <span className="title-spacer" />
        <small className="right">Code: {user_code}</small>
        <button
          type="button"
          className="edit-button"
          onClick={goEdit}
          aria-label="基本情報を修正"
        >
          <span className="edit-icon" aria-hidden>✎</span>
          修正
        </button>
      </header>

      <div className="profile-basic__body">
        <div className="profile-avatar">
          {avatar_url ? (
            <img src={avatar_url} alt="avatar" />
          ) : (
            <div className="avatar-placeholder">No Image</div>
          )}
        </div>

        <div className="profile-basic__grid">
          <div className="row">
            <div className="label">ニックネーム</div>
            <div className="value">{name || '—'}</div>
          </div>
          <div className="row">
            <div className="label">誕生日</div>
            <div className="value">{birthday || '—'}</div>
          </div>
          <div className="row">
            <div className="label">所在地</div>
            <div className="value">
              {[prefecture, city].filter(Boolean).join(' ') || '—'}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
