// src/components/UserProfile/UserProfileEditor.tsx
'use client';

import React, { useEffect, useState } from 'react';
import type { Profile } from './index';
import ProfileBasic from './ProfileBasic';
import ProfileSNS from './ProfileSNS';
import ProfileSkills from './ProfileSkills';
import './ProfileBox.css';

export default function UserProfileEditor() {
  const [data, setData] = useState<Profile | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // ロード
  useEffect(() => {
    (async () => {
      try {
        const idToken = await (await import('@/lib/getIdToken')).default();
        const r = await fetch('/api/mypage/me', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
        });
        const j = await r.json();
        if (j?.me) setData(j.me as Profile);
        else setMsg('プロフィール取得に失敗しました');
      } catch (e: any) {
        setMsg(e?.message || '読み込みエラー');
      }
    })();
  }, []);

  // 差分適用
  const patch = (p: Partial<Profile>) =>
    setData((d) => ({ ...(d as Profile), ...p }));

  // 文字列/配列のゆらぎを吸収
  const toArray = (v: string[] | string | null | undefined) => {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') {
      const a = v
        .split(/[、,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return a;
    }
    return [];
  };

  // フルURL → ストレージキーへ（保存時）
  const toStorageKey = (urlOrKey: string | null | undefined) => {
    if (!urlOrKey) return '';
    const v = String(urlOrKey);
    if (!/^https?:\/\//i.test(v)) return v; // 既にキー
    const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
    const prefix = `${base}/storage/v1/object/public/avatars/`;
    return v.startsWith(prefix) ? v.slice(prefix.length) : v;
  };

  // 保存
  async function handleSave() {
    if (!data) return;
    setSaving(true);
    setMsg(null);
    try {
      const idToken = await (await import('@/lib/getIdToken')).default();
      const payload = {
        // users 側
        click_email: (data as any)?.click_email ?? '',
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
        interests: toArray(data.interests),
        skills: toArray(data.skills),
        activity_area: toArray(data.activity_area),
        languages: toArray(data.languages),
        visibility: data.visibility ?? 'public',
        avatar_url: toStorageKey(data.avatar_url), // ← ここがポイント
      };

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

  return (
    <div className="edit-wrapper">
      <div className="edit-header">
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>マイページ編集</h1>
          {(data as any)?.REcode ? (
            <div className="page-sub">REcode: {(data as any).REcode}</div>
          ) : null}
        </div>
        <button className="mu-primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中…' : '💾 保存'}
        </button>
      </div>

      {msg && <div className="mu-toast">{msg}</div>}

      {/* 既存コンポーネントのまま */}
      <section className="profile-card">
        <ProfileBasic profile={data} editable onChange={patch} />
      </section>
      <section className="profile-card">
        <ProfileSNS profile={data} editable onChange={patch} />
      </section>
      <section className="profile-card">
        <ProfileSkills profile={data} editable onChange={patch} />
      </section>
    </div>
  );
}
