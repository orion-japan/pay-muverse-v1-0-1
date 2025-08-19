'use client';

import { useEffect, useState, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getAuth } from 'firebase/auth';
import UserProfile, { Profile } from '@/components/UserProfile/UserProfile';
import './profile.css';

export default function ProfilePage() {
  const { code } = useParams(); // /profile/[code]
  const codeStr = String(code ?? ''); // 文字列に統一
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isMyPage, setIsMyPage] = useState(false);
  const [followStatus, setFollowStatus] = useState<'none' | 'following'>('none');
  const [myCode, setMyCode] = useState<string | null>(null); 
  const [clickType, setClickType] = useState<string>('free'); // ★ APIの値を保持
  const router = useRouter();

  // 🔹 プロフィール読み込み
  useEffect(() => {
    (async () => {
      try {
        const auth = getAuth();
        const user = auth.currentUser;

        if (!user) {
          router.push('/login');
          return;
        }

        // Firebase トークンを取得
        const token = await user.getIdToken(true);
        const res = await fetch('/api/account-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
        });

        let mine: string | null = null;
        if (res.ok) {
          const j = await res.json();
          mine = j?.user_code ?? null;
          setMyCode(mine); 
          setClickType(j?.click_type ?? 'free'); // ★ click_typeを保存
        }

        if (!codeStr) return;

        // ✅ 自分のページか判定
        setIsMyPage(!!mine && codeStr === mine);

        // プロフィール取得（対象ユーザー）
        const rp = await fetch(`/api/get-profile?code=${encodeURIComponent(codeStr)}`);
        if (!rp.ok) {
          setProfile(null);
          return;
        }
        const p = await rp.json();

        const base = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/+$/, '');
        let avatar_url: string | null = p?.avatar_url ?? null;
        if (avatar_url && base && !/^https?:\/\//i.test(avatar_url)) {
          avatar_url = `${base}/storage/v1/object/public/avatars/${avatar_url}`;
        }

        const toDisplay = (v: string[] | string | null | undefined) =>
          Array.isArray(v) ? v : v ?? '';

        setProfile({
          user_code: codeStr,
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
        });

        // ✅ フォロー状態チェック
        if (mine && codeStr !== mine) {
          const resFollow = await fetch(
            `/api/check-follow?target=${encodeURIComponent(codeStr)}&me=${encodeURIComponent(mine)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (resFollow.ok) {
            const f = await resFollow.json();
            setFollowStatus(f.isFollowing ? 'following' : 'none');
          }
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [codeStr, router]);

  // 🔹 click_type → planStatus 正規化
  const planStatus = useMemo<
    'free' | 'regular' | 'premium' | 'master' | 'admin'
  >(() => {
    switch (clickType) {
      case 'regular': return 'regular';
      case 'premium': return 'premium';
      case 'master': return 'master';
      case 'admin': return 'admin';
      default: return 'free';
    }
  }, [clickType]);

  // 🔹 フォロー処理
  const handleFollow = async () => {
    const auth = getAuth();
    const user = auth.currentUser;
    if (!user) return alert('ログインしてください');
    if (!myCode) return alert('ユーザーコード取得に失敗しました。再読み込みしてください。');
    if (codeStr === myCode) return;

    const token = await user.getIdToken(true);

    const res = await fetch('/api/follow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_user_code: codeStr, from_user_code: myCode }),
    });
    if (res.ok) {
      setFollowStatus('following');
    } else {
      const msg = await res.text().catch(() => '');
      alert(`フォローに失敗しました ${msg ? `\n${msg}` : ''}`);
    }
  };

  // 🔹 アンフォロー処理
  const handleUnfollow = async () => {
    const auth = getAuth();
    const user = auth.currentUser;
    if (!user) return alert('ログインしてください');
    if (!myCode) return;

    const token = await user.getIdToken(true);

    const res = await fetch('/api/unfollow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to_user_code: codeStr, from_user_code: myCode }),
    });
    if (res.ok) {
      setFollowStatus('none');
    } else {
      const msg = await res.text().catch(() => '');
      alert(`フォロー解除に失敗しました ${msg ? `\n${msg}` : ''}`);
    }
  };

  if (loading) return <p>読み込み中...</p>;
  if (!profile) return <p>プロフィールが見つかりません</p>;

  return (
    <div className="profile-wrapper">
      {/* ✅ シップ制度も含めて UserProfile に渡す */}
      <UserProfile
        profile={profile}
        myCode={myCode ?? undefined}
        isMyPage={isMyPage}
        planStatus={planStatus}
        onOpenTalk={() => router.push(`/talk?with=${encodeURIComponent(codeStr)}`)}
      />
  
      {/* 🚫 フォロー機能は一時廃止するので削除 */}
      {/*
      {!isMyPage && (
        <div className="follow-section">
          {followStatus === 'none' && (
            <button onClick={handleFollow} className="follow-btn">
              ➕ フォロー
            </button>
          )}
          {followStatus === 'following' && (
            <button onClick={handleUnfollow} className="follow-btn following">
              ✅ フォロー中
            </button>
          )}
        </div>
      )}
      */}
  
      {/* ✅ 自分のページなら編集ボタン */}
      {isMyPage && (
        <div className="my-actions">
          <button onClick={() => router.push('/mypage/create')} className="edit-btn">
            ✏️ プロフィールを編集
          </button>
        </div>
      )}
    </div>
  );
}