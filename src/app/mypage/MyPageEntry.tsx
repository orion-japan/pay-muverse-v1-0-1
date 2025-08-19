'use client';

import React, { useMemo } from 'react';
import styles from './MyPageEntry.module.css';

type MaybeArray = string[] | string | null | undefined;

export type Profile = {
  user_code: string;
  /** ← 追加：users.click_username を受けられるように */
  click_username?: string;
  /** 既存の profiles.name（フォールバック用） */
  name?: string;

  birthday?: string;
  prefecture?: string;
  city?: string;
  x_handle?: string;
  instagram?: string;
  facebook?: string;
  linkedin?: string;
  youtube?: string;
  website_url?: string;
  interests?: MaybeArray;
  skills?: MaybeArray;
  activity_area?: MaybeArray;
  languages?: MaybeArray;
  avatar_url?: string | null; // ストレージキー or フルURL
};

type Props = { profile: Profile };

const toDisplayString = (v: MaybeArray) => {
  if (!v) return '—';
  return Array.isArray(v) ? (v.length ? v.join('、') : '—') : (v || '—');
};

const toChips = (v: MaybeArray) => {
  if (!v) return [];
  return Array.isArray(v) ? v : v.split(/[、,]+/).map((s) => s.trim()).filter(Boolean);
};

const linkOrDash = (u?: string) =>
  u && u.trim()
    ? (
      <a href={/^https?:\/\//i.test(u) ? u : `https://${u}`} target="_blank" rel="noopener noreferrer">
        {u}
      </a>
    )
    : '—';

export default function MyPageEntry({ profile }: Props) {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const avatarUrl = useMemo(() => {
    const key = profile.avatar_url || '';
    if (!key) return '';
    if (/^https?:\/\//i.test(key)) return key;
    return base ? `${base}/storage/v1/object/public/avatars/${key}` : '';
  }, [profile.avatar_url, base]);

  const location = [profile.prefecture, profile.city].filter(Boolean).join(' ') || '—';

  // ▼ ここを変更：表示名は click_username 優先、無ければ name
  const displayName = profile.click_username || profile.name || 'ニックネーム未設定';

  return (
    <div className={styles.pageBg}>
      <div className={styles.container}>
        {/* ヘッダー（アバター + 基本情報 + 編集ボタン） */}
        <section className={styles.hero}>
          <div className={styles.avatarWrap}>
            {avatarUrl ? (
              <img className={styles.avatar} src={avatarUrl} alt="avatar" />
            ) : (
              <div className={styles.avatarPlaceholder}>No Image</div>
            )}
          </div>

          <div className={styles.headMeta}>
            <div className={styles.titleRow}>
              <h1 className={styles.displayName}>{displayName}</h1>
              <span className={styles.userCode}>Code: {profile.user_code}</span>
            </div>
            <div className={styles.metaGrid}>
              <div>
                <div className={styles.metaLabel}>誕生日</div>
                <div className={styles.metaValue}>{profile.birthday || '—'}</div>
              </div>
              <div>
                <div className={styles.metaLabel}>所在地</div>
                <div className={styles.metaValue}>{location}</div>
              </div>
            </div>
          </div>

          <div className={styles.headAction}>
            <a className={styles.editBtn} href="/mypage/create">プロフィールを編集</a>
          </div>
        </section>

        {/* SNS / Link */}
        <section className={styles.card}>
          <div className={styles.cardHeader}>SNS / Link</div>
          <div className={styles.linksGrid}>
            <div><span className={styles.icon}>𝕏</span> {linkOrDash(profile.x_handle)}</div>
            <div><span className={styles.icon}>📷</span> {linkOrDash(profile.instagram)}</div>
            <div><span className={styles.icon}>📘</span> {linkOrDash(profile.facebook)}</div>
            <div><span className={styles.icon}>💼</span> {linkOrDash(profile.linkedin)}</div>
            <div><span className={styles.icon}>▶️</span> {linkOrDash(profile.youtube)}</div>
            <div><span className={styles.icon}>🌐</span> {linkOrDash(profile.website_url)}</div>
          </div>
        </section>

        {/* スキル・興味 */}
        <section className={styles.splitGrid}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>スキル</div>
            <div className={styles.chips}>
              {toChips(profile.skills).length
                ? toChips(profile.skills).map((t, i) => <span key={i} className={styles.chip}>#{t}</span>)
                : <div className={styles.muted}>—</div>}
            </div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardHeader}>興味</div>
            <div className={styles.chips}>
              {toChips(profile.interests).length
                ? toChips(profile.interests).map((t, i) => <span key={i} className={styles.chip}>{t}</span>)
                : <div className={styles.muted}>—</div>}
            </div>
          </div>
        </section>

        {/* 活動地域・対応言語 */}
        <section className={styles.splitGrid}>
          <div className={styles.card}>
            <div className={styles.cardHeader}>活動地域</div>
            <div className={styles.textBlock}>{toDisplayString(profile.activity_area)}</div>
          </div>
          <div className={styles.card}>
            <div className={styles.cardHeader}>対応言語</div>
            <div className={styles.textBlock}>{toDisplayString(profile.languages)}</div>
          </div>
        </section>
      </div>
    </div>
  );
}
