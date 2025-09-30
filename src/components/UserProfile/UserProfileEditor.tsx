// src/components/UserProfile/UserProfileEditor.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import ProfileBasic from './ProfileBasic';
import ProfileSNS from './ProfileSNS';
import ProfileSkills from './ProfileSkills';
import './ProfileBox.css';
import SafeImage from '@/components/common/SafeImage';
import getIdToken from '@/lib/getIdToken';
import { resizeImage } from '@/utils/imageResize';

// --- Types ---
type MaybeArray = string[] | string | null | undefined;

type ProfileData = {
  // users
  user_code: string;
  click_username?: string | null;
  click_email?: string | null;
  headline?: string | null;
  mission?: string | null;
  looking_for?: string | null;
  position?: string | null;
  organization?: string | null;

  // profiles
  name?: string | null; // 表示名フォールバック用
  bio?: string | null;
  birthday?: string | null;
  prefecture?: string | null;
  city?: string | null;
  x_handle?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  linkedin?: string | null;
  youtube?: string | null;
  website_url?: string | null;
  interests?: MaybeArray;
  skills?: MaybeArray;
  activity_area?: MaybeArray;
  languages?: MaybeArray;
  visibility?: string | null;
  profile_link?: string | null;
  avatar_url?: string | null; // publicURL or storage-key

  // readonly-ish
  Rcode?: string | null;
  REcode?: string | null;
};

// --- helpers ---
const toCsv = (v?: string[] | null) => (Array.isArray(v) ? v.join(', ') : '');
const toArr = (s: string): string[] =>
  s.split(/[、,]+/).map((x) => x.trim()).filter(Boolean);

// フルURL → ストレージキー（保存時）
const toStorageKey = (urlOrKey?: string | null): string => {
  if (!urlOrKey) return '';
  const v = String(urlOrKey);
  if (!/^https?:\/\//i.test(v)) return v; // 既にキー
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
  const prefix = `${base}/storage/v1/object/public/avatars/`;
  return v.startsWith(prefix) ? v.slice(prefix.length) : v;
};

export default function UserProfileEditor() {
  const [data, setData] = useState<ProfileData | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // 初回ロード
  useEffect(() => {
    (async () => {
      try {
        const idToken = await getIdToken();
        const r = await fetch('/api/mypage/me', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store',
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error || 'プロフィール取得に失敗しました');

        const me = j.me as ProfileData;
        const uc = j.user_code as string;
        // 表示名は click_username 優先
        setData({ ...me, name: me.click_username ?? me.name ?? '' });
        setUserCode(uc);
      } catch (e: any) {
        setMsg(e?.message || '読み込みエラー');
      }
    })();
  }, []);

  // 差分適用
  const patch = (p: Partial<ProfileData>) =>
    setData((d) => ({ ...(d as ProfileData), ...p }));

  // 表示用アバターURL（キャッシュバスター）
  const avatarUrl = useMemo(() => {
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
    const raw = data?.avatar_url || '';
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw)) return `${raw}?t=${Date.now()}`;
    const key = raw.startsWith('avatars/') ? raw.slice('avatars/'.length) : raw;
    return `${base}/storage/v1/object/public/avatars/${key}?t=${Date.now()}`;
  }, [data?.avatar_url]);

  // 画像選択 → リサイズ → ストレージにアップロード → avatar_url（キー）保存
  async function handlePickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    if (!e.target.files?.[0] || !data || !userCode) return;
    const file = e.target.files[0];
    setUploading(true);
    setMsg(null);
    try {
      // 1) リサイズ（webp 推奨）
      const blob: Blob = await resizeImage(file, { max: 512, type: 'image/webp', quality: 0.9 });

      // 2) 自前APIへ FormData で送信（サーバーが Service Role で保存）
      const fd = new FormData();
      fd.append('file', blob, 'avatar.webp');

      const idToken = await getIdToken();
      const r = await fetch('/api/mypage/upload-avatar', {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: fd,
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'アップロードに失敗しました');

      // 3) 返ってきたキーで UI を更新
      patch({ avatar_url: j.path as string });
      setMsg('アバターを更新しました ✅');
    } catch (e: any) {
      setMsg(e?.message || 'アバター更新エラー');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  // 保存（テキスト等）
  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setMsg(null);
    try {
      const idToken = await getIdToken();

      const payload: any = {
        // users 側
        click_username: data.name ?? '',
        headline: data.headline ?? '',
        mission: data.mission ?? '',
        looking_for: data.looking_for ?? '',
        position: data.position ?? '',
        organization: data.organization ?? '',
        // profiles 側
        bio: data.bio ?? '',
        birthday: data.birthday ?? null,
        prefecture: data.prefecture ?? '',
        city: data.city ?? '',
        x_handle: data.x_handle ?? '',
        instagram: data.instagram ?? '',
        facebook: data.facebook ?? '',
        linkedin: data.linkedin ?? '',
        youtube: data.youtube ?? '',
        website_url: data.website_url ?? '',
        interests: toArr(toCsv((data.interests as string[] | null) || [])),
        skills: toArr(toCsv((data.skills as string[] | null) || [])),
        activity_area: toArr(toCsv((data.activity_area as string[] | null) || [])),
        languages: toArr(toCsv((data.languages as string[] | null) || [])),
        visibility: data.visibility ?? 'public',
        // avatar_url はキーで保持（ここで変更しない）
        avatar_url: toStorageKey(data.avatar_url || ''),
      };

      // NOT NULL の click_email は空なら送らない
      if (data.click_email && String(data.click_email).trim()) {
        payload.click_email = String(data.click_email).trim();
      }

      const r = await fetch('/api/mypage/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j?.error || '保存に失敗しました');

      setMsg('保存しました ✅');
    } catch (e: any) {
      setMsg(e?.message || '保存エラー');
    } finally {
      setSaving(false);
    }
  }

  if (!data) {
    return (
      <div className="mu-card">
        <p>{msg || '読み込み中…'}</p>
      </div>
    );
  }

  const displayName = data.click_username ?? data.name ?? 'ニックネーム未設定';

  return (
    <div className="edit-wrapper">
      <div className="edit-header">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>マイページ編集</h1>
          {userCode ? <div className="page-sub">Code: {userCode}</div> : null}
        </div>
        <button className="mu-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '💾 保存'}
        </button>
      </div>

      {msg && <div className="mu-toast">{msg}</div>}

      {/* Avatar block */}
      <section className="profile-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ width: 96, height: 96, borderRadius: '50%', overflow: 'hidden', background: '#eee' }}>
            {avatarUrl ? (
              <SafeImage src={avatarUrl} alt="avatar" aspectRatio="1/1" className="avatar-preview" />
            ) : (
              <div style={{ width: '100%', height: '100%', display: 'grid', placeItems: 'center', color: '#888' }}>
                No Image
              </div>
            )}
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: 18 }}>{displayName}</div>
            <label className="mu-secondary" style={{ display: 'inline-block', marginTop: 8 }}>
              {uploading ? 'アップロード中…' : '🖼 アバターを選択'}
              <input type="file" accept="image/*" onChange={handlePickAvatar} style={{ display: 'none' }} />
            </label>
          </div>
        </div>
      </section>

      {/* 既存コンポーネント */}
      <section className="profile-card">
        <ProfileBasic profile={data as any} editable onChange={patch} />
      </section>
      <section className="profile-card">
        <ProfileSNS profile={data as any} editable onChange={patch} />
      </section>
      <section className="profile-card">
        <ProfileSkills profile={data as any} editable onChange={patch} />
      </section>

      {/* 読み取り専用の紹介コードなど（ある場合） */}
      {(data.Rcode || data.REcode) && (
        <section className="mu-card subtle">
          <h2>紹介コード</h2>
          <div className="grid-2">
            <div className="readonly-chip">
              <span>Rcode</span>
              <strong>{data.Rcode || '—'}</strong>
            </div>
            <div className="readonly-chip">
              <span>REcode</span>
              <strong>{data.REcode || '—'}</strong>
            </div>
          </div>
          <p className="hint">REcode は表示のみ（変更不可）</p>
        </section>
      )}
    </div>
  );
}
