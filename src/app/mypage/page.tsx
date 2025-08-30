'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import UserProfile from '@components/UserProfile/UserProfile';
import type { Profile } from '@components/UserProfile';

import './mypage.css';

export default function MyPage() {
  const [profileState, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    const auth = getAuth();
    let mounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
      if (!mounted) return;

      if (!user) {
        router.push('/login');
        setLoading(false);
        return;
      }

      try {
        const token = await user.getIdToken(true);

        // user_code 取得
        let user_code: string | null = null;
        const endpoints = ['/api/account-status', '/api/get-current-user'];
        for (const ep of endpoints) {
          try {
            const r = await fetch(ep, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({}),
            });
            if (r.ok) {
              const j = await r.json();
              if (j?.user_code) {
                user_code = j.user_code;
                break;
              }
            }
          } catch { /* noop */ }
        }

        if (!user_code) {
          if (mounted) setProfileState(null);
          return;
        }

        // プロフィール取得
        const rp = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`);
        if (!rp.ok) {
          if (mounted) setProfileState(null);
          return;
        }
        const p = await rp.json();

        // avatar_url のフルURL化
        const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
        let avatar_url: string | null = p?.avatar_url ?? null;
        if (avatar_url && base && !/^https?:\/\//i.test(avatar_url)) {
          avatar_url = `${base}/storage/v1/object/public/avatars/${avatar_url}`;
        }

        const toDisplay = (v: string[] | string | null | undefined) =>
          Array.isArray(v) ? v : v ?? '';

        const profileForUI: Profile = {
          user_code,
          name: p?.name ?? '',
          birthday: p?.birthday ?? '',
          prefecture: p?.prefecture ?? '',
          city: p?.city ?? '',
          x_handle: p?.x_handle ?? '',
          instagram: p?.instagram ?? '',
          facebook: p?.facebook ?? '',
          linkedin: p?.linkedin ?? '',
          youtube: p?.youtube ?? '',
          website_url: p?.website_url ?? '',
          interests: toDisplay(p?.interests),
          skills: toDisplay(p?.skills),
          activity_area: toDisplay(p?.activity_area),
          languages: toDisplay(p?.languages),
          avatar_url,
          REcode: p?.REcode ?? '', // ← ここで取り込み
        };

        if (mounted) setProfileState(profileForUI);
      } finally {
        if (mounted) setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [router]);

  if (loading) {
    return (
      <div className="mypage-container">
        <p>読み込み中...</p>
      </div>
    );
  }

  if (!profileState) {
    return (
      <div style={{ padding: 24 }}>
        <h1>マイページ</h1>
        <p>プロフィールが登録されていません</p>
        <button className="register-button" onClick={() => router.push('/mypage/create')}>
          🚀 登録する
        </button>
      </div>
    );
  }

  return (
    <div className="mypage-wrapper">
      <div className="mypage-container">
        {/* ▼ 見出し（右側に REcode 表示） */}
        <section className="profile-card" style={{ marginTop: 8 }}>
          <div className="page-head">
            <h1 className="page-title">マイページ</h1>
            <div className="page-sub">{profileState.REcode || '—'}</div>
          </div>
        </section>

        {/* プロフィール本体（自分ページなので isMyPage を渡す） */}
        <UserProfile profile={profileState} isMyPage />

        {/* 操作ボタン */}
        <div className="my-actions-row">
          <button className="edit-btn" onClick={() => router.push('/mypage/create')}>
            ✏️ プロフィールを編集
          </button>
          <Link href="/mypage/settings" className="settings-btn">
            ⚙️ 設定
          </Link>
        </div>
      </div>
    </div>
  );
}
