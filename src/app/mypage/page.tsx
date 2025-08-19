'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link'; // ✅ 追加
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import UserProfile, { Profile } from '@/components/UserProfile/UserProfile';
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

        // 1) 推奨: /api/account-status から user_code を取得
        let user_code: string | null = null;
        try {
          const r = await fetch('/api/account-status', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({}),
          });
          if (r.ok) {
            const j = await r.json();
            user_code = j?.user_code ?? null;
          }
        } catch {
          /* noop */
        }

        // 2) フォールバック: /api/get-current-user
        if (!user_code) {
          try {
            const r = await fetch('/api/get-current-user', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
              },
              body: JSON.stringify({}),
            });
            if (r.ok) {
              const j = await r.json();
              user_code = j?.user_code ?? null;
            }
          } catch {
            /* noop */
          }
        }

        if (!user_code) {
          if (mounted) setProfileState(null);
          return;
        }

        // 3) プロフィール取得
        const rp = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`);
        if (!rp.ok) {
          if (mounted) setProfileState(null);
          return;
        }
        const p = await rp.json();

        // 4) avatar_url がストレージキーならフルURL化
        const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
        let avatar_url: string | null = p?.avatar_url ?? null;
        if (avatar_url && base && !/^https?:\/\//i.test(avatar_url)) {
          avatar_url = `${base}/storage/v1/object/public/avatars/${avatar_url}`;
        }

        // 5) UserProfile 用に整形
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

  // 未登録時
  if (!profileState) {
    return (
      <div style={{ padding: 24 }}>
        <h1>マイページ</h1>
        <p>プロフィールが登録されていません</p>
        <button
          className="register-button"
          onClick={() => router.push('/mypage/create')}
        >
          🚀 登録する
        </button>
      </div>
    );
  }

  // ✅ 構造は維持。下部に「編集」「設定」アクションを追加
  return (
    <div className="mypage-wrapper">
      <div className="mypage-container">
        <UserProfile profile={profileState} />

        {/* ▼ 追加: マイページ操作行（既存レイアウトを崩さない軽量な行） */}
        <div className="my-actions-row">
          <button
            className="edit-btn"
            onClick={() => router.push('/mypage/create')}
          >
            ✏️ プロフィールを編集
          </button>

          <Link href="/mypage/settings" className="settings-btn" aria-label="設定へ">
            ⚙️ 設定
          </Link>
        </div>
      </div>
    </div>
  );
}
