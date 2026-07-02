// src/app/mypage/page.tsx
'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuth, onAuthStateChanged, type User } from 'firebase/auth';
import QRCode from 'qrcode';

import { UserProfile, type Profile } from '@/components/UserProfile';
import getIdToken from '@/lib/getIdToken';
import './mypage.css';

/** 共通: 値の安全取得 */
function pickString(obj: any, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v != null && typeof v !== 'object' && `${v}`.trim()) return `${v}`.trim();
  }
  return null;
}

export default function MyPage() {
  const [profileState, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // 招待リンク（短縮URL）
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // app_code の解決（既存ロジックは流用）
  const resolveAppCode = async (token: string, user_code: string): Promise<string | null> => {
    try {
      // 1) invite-info
      {
        const r = await fetch('/api/my/invite-info', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        const j = await r.json().catch(() => ({}));
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }
      // 2) account-status
      {
        const r = await fetch('/api/account-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
          cache: 'no-store',
        });
        const j = await r.json().catch(() => ({}));
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }
      // 3) get-current-user
      {
        const r = await fetch('/api/get-current-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({}),
          cache: 'no-store',
        });
        const j = await r.json().catch(() => ({}));
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }
      // 4) get-profile（互換吸収）
      {
        const r = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`, {
          cache: 'no-store',
        });
        const j = await r.json().catch(() => ({}));
        const ac = pickString(j, 'app_code', 'appCode', 'appcode', 'REcode', 'recode', 're_code');
        if (ac) return ac;
      }
    } catch {}
    return null;
  };

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
        // ここからは **/api/mypage/me** を一次ソースに統一
        const idToken = await getIdToken();

        const r = await fetch('/api/mypage/me', {
          method: 'POST',
          headers: { Authorization: `Bearer ${idToken}` },
          cache: 'no-store', // 最新を常に取得
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j?.me) {
          setProfileState(null);
          setLoading(false);
          return;
        }

        const me = j.me as any; // v_mypage_user の 1 行
        const user_code: string = j.user_code || me.user_code;

        // アバターURLのフル化（キーで来た場合）
        const base = (process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
        let avatar_url: string | null = me?.avatar_url ?? null;
        if (avatar_url && base && !/^https?:\/\//i.test(avatar_url)) {
          avatar_url = `${base}/storage/v1/object/public/avatars/${avatar_url}`;
        }

        // Array/CSV ゆらぎ吸収
        const toDisplay = (v: string[] | string | null | undefined) =>
          Array.isArray(v) ? v : (v ?? '');

        const profileForUI: Profile = {
          user_code,
          // 表示名は v_mypage_user.name（= coalesce(click_username, profiles.name)）
          name: me?.name ?? '',

          // ← ここが重要：**profiles 由来の編集項目をすべて含める**
          headline: me?.headline ?? '',
          organization: me?.organization ?? '',
          position: me?.position ?? '',
          bio: me?.bio ?? '',
          mission: me?.mission ?? '',
          looking_for: me?.looking_for ?? '',

          birthday: me?.birthday ?? '',
          prefecture: me?.prefecture ?? '',
          city: me?.city ?? '',

          x_handle: me?.x_handle ?? '',
          instagram: me?.instagram ?? '',
          facebook: me?.facebook ?? '',
          linkedin: me?.linkedin ?? '',
          youtube: me?.youtube ?? '',
          website_url: me?.website_url ?? '',

          interests: toDisplay(me?.interests),
          skills: toDisplay(me?.skills),
          activity_area: toDisplay(me?.activity_area),
          languages: toDisplay(me?.languages),

          avatar_url,
          // 招待コード等（表示のみ）
          REcode: me?.REcode ?? '',
        };

        if (mounted) setProfileState(profileForUI);

        // 招待用URLの生成：join.muverse.jp/register へ直接渡すURLを invite_links に保存 → join.muverse.jp/i/xxxx を表示
        setLinkLoading(true);
        try {
          const appCode = await resolveAppCode(idToken, user_code);
          if (!appCode) throw new Error('app_code が取得できませんでした。');

          let rcode = '',
            mcode = '',
            eve = '';
          try {
            const ri = await fetch('/api/my/invite-info', {
              method: 'GET',
              headers: { Authorization: `Bearer ${idToken}` },
              cache: 'no-store',
            });
            const ji = await ri.json().catch(() => ({}));
            rcode = pickString(ji, 'rcode') ?? '';
            mcode = pickString(ji, 'mcode') ?? '';
            eve = pickString(ji, 'eve', 'code') ?? '';
          } catch {}

          const params = new URLSearchParams();
          params.set('ref', appCode);
          if (rcode) params.set('rcode', rcode);
          if (mcode) params.set('mcode', mcode);
          if (eve) params.set('eve', eve);
          params.set('media_code', 'AP');

          const registerOrigin = process.env.NEXT_PUBLIC_JOIN_BASE_URL || 'https://join.muverse.jp';
          const registerLink = `${registerOrigin.replace(/\/+$/, '')}/register?${params.toString()}`;

          try {
            const shortRes = await fetch('/api/my/short-invite-link', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
              },
              body: JSON.stringify({
                destination_url: registerLink,
                ref: appCode,
                rcode,
                mcode,
                media_code: 'AP',
                label: `${profileForUI.name || user_code} 招待リンク`,
              }),
              cache: 'no-store',
            });
            const shortJson = await shortRes.json().catch(() => ({}));
            if (shortRes.ok && shortJson?.ok && shortJson?.short_url) {
              if (mounted) setJoinLink(shortJson.short_url);
            } else {
              if (mounted) {
                setJoinLink(registerLink);
                setLinkMsg(`短縮URL生成エラー: ${shortJson?.error || '登録URLを表示しています'}`);
              }
            }
          } catch (shortErr: any) {
            if (mounted) {
              setJoinLink(registerLink);
              setLinkMsg(`短縮URL生成エラー: ${shortErr?.message || shortErr}`);
            }
          }
        } catch (e: any) {
          if (mounted) setLinkMsg(`URL生成エラー: ${e?.message || e}`);
        } finally {
          if (mounted) setLinkLoading(false);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [router]);

  // LINE共有
  const shareViaLINE = () => {
    if (!joinLink) return;
    const text = `Muverse 招待リンク\n${joinLink}`;
    const url = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // QR生成（短縮URLを埋め込む）
  useEffect(() => {
    if (!joinLink || !qrCanvasRef.current) return;
    QRCode.toCanvas(qrCanvasRef.current, joinLink, { width: 240, margin: 1 }, (err) => {
      if (err) console.error('QR gen error:', err);
    });
  }, [joinLink]);

  // QRダウンロード
  const downloadQR = () => {
    if (!qrCanvasRef.current) return;
    const url = qrCanvasRef.current.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'muverse-invite-qr.png';
    a.click();
  };

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
        <section className="profile-card" style={{ marginTop: 8 }}>
          <div className="page-head">
            <h1 className="page-title">マイページ</h1>
            <div className="page-sub">{(profileState as any).REcode || '—'}</div>
          </div>
        </section>

        <UserProfile profile={profileState} isMyPage />

        {/* 招待URL */}
        <section className="profile-card" style={{ marginTop: 12 }}>
          <h2 className="section-title" style={{ margin: '0 0 8px' }}>
            あなた専用の招待リンク
          </h2>

          {linkLoading && <p style={{ margin: 0 }}>URL を準備中...</p>}
          {!linkLoading && linkMsg && <p style={{ color: '#b91c1c', margin: 0 }}>{linkMsg}</p>}

          {!linkLoading && joinLink && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div
                style={{
                  display: 'grid',
                  gap: 8,
                  background: '#f9fafb',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: 10,
                }}
              >
                <div style={{ fontSize: 12, wordBreak: 'break-all', color: '#111827' }}>{joinLink}</div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="settings-btn" onClick={shareViaLINE}>
                    💚 LINEで共有
                  </button>
                  <button
                    className="settings-btn"
                    onClick={async () => {
                      if (joinLink) await navigator.clipboard.writeText(joinLink);
                    }}
                  >
                    📋 リンクをコピー
                  </button>
                </div>
                <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>
                  ※ QRコードにもこの短縮URLが入ります。
                </p>
              </div>

              {/* QRのみ */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: 12,
                  alignItems: 'center',
                }}
              >
                <canvas ref={qrCanvasRef} style={{ width: 160, height: 160 }} />
                <div style={{ display: 'grid', gap: 8 }}>
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    イベントや対面案内では、このQRを見せるだけでOKです。
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <button className="settings-btn" onClick={downloadQR}>
                      ⬇️ QRを保存（PNG）
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="my-actions-row">
          <button className="edit-btn" onClick={() => router.push('/mypage/create')}>
            ✏️ プロフィールを編集
          </button>
          <Link href="/iros-ai/settings" className="settings-btn">
            ⚙️ 設定
          </Link>
        </div>
      </div>
    </div>
  );
}
