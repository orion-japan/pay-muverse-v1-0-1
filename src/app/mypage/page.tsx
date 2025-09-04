// src/app/mypage/page.tsx
'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import QRCode from 'qrcode';

import { UserProfile, type Profile } from '@/components/UserProfile';
import './mypage.css';

/** ------------------------------
 * 共通: 値の安全取得ヘルパ
 * ------------------------------ */
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

  // 参加リンク
  const [joinLink, setJoinLink] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkMsg, setLinkMsg] = useState<string | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

  /** -----------------------------------------
   * app_code 解決ロジック（フロント側の最終防衛線）
   * 優先順:
   *   1) /api/my/invite-info の返却
   *   2) /api/account-status の返却
   *   3) /api/get-current-user の返却
   *   4) /api/get-profile?code=xxxxx の返却（フィールド名が REcode / app_code などの場合を吸収）
   * 見つからなければ null を返す
   * ----------------------------------------- */
  const resolveAppCode = async (token: string, user_code: string): Promise<string | null> => {
    try {
      // 1) invite-info
      {
        const r = await fetch('/api/my/invite-info', {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
        const j = await r.json().catch(() => ({}));
        console.log('[invite-info]', j);
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }

      // 2) account-status
      {
        const r = await fetch('/api/account-status', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        });
        const j = await r.json().catch(() => ({}));
        console.log('[account-status]', j);
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }

      // 3) get-current-user
      {
        const r = await fetch('/api/get-current-user', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({}),
        });
        const j = await r.json().catch(() => ({}));
        console.log('[get-current-user]', j);
        const ac = pickString(j, 'app_code', 'appCode', 'appcode');
        if (ac) return ac;
      }

      // 4) get-profile (列名違いの吸収: REcode / app_code など)
      {
        const r = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`);
        const j = await r.json().catch(() => ({}));
        console.log('[get-profile]', j);
        // プロファイルに app_code を置いている or REcode を app_code として使うケースを吸収
        const ac = pickString(j, 'app_code', 'appCode', 'appcode', 'REcode', 'recode', 're_code');
        if (ac) return ac;
      }
    } catch (e) {
      console.warn('[resolveAppCode] error', e);
    }
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
        const token = await user.getIdToken(true);

        // user_code（プロフィール用）
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
          } catch {}
        }

        if (!user_code) {
          if (mounted) setProfileState(null);
          return;
        }

        // プロフィール取得（表示用）
        const rp = await fetch(`/api/get-profile?code=${encodeURIComponent(user_code)}`);
        if (!rp.ok) {
          if (mounted) setProfileState(null);
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
          REcode: p?.REcode ?? '',
        };

        if (mounted) setProfileState(profileForUI);

        // 参加用URL生成
        setLinkLoading(true);
        try {
          // ---- app_code を確実に解決 ----
          const appCode = await resolveAppCode(token, user_code);
          if (!appCode) {
            throw new Error('app_code が取得できませんでした。');
          }

          // rcode / mcode / eve は /api/my/invite-info を一次ソースに
          let rcode = '', mcode = '', eve = '';
          try {
            const r = await fetch('/api/my/invite-info', {
              method: 'GET',
              headers: { Authorization: `Bearer ${token}` },
            });
            const j = await r.json().catch(() => ({}));
            rcode = pickString(j, 'rcode') ?? '';
            mcode = pickString(j, 'mcode') ?? '';
            eve   = pickString(j, 'eve', 'code') ?? '';
          } catch {}

          const params = new URLSearchParams();
          params.set('ref', appCode);     // 必須
          if (rcode) params.set('rcode', rcode);
          if (mcode) params.set('mcode', mcode);
          if (eve)   params.set('eve', eve);

          const finalLink = `https://join.muverse.jp/register?${params.toString()}`;
          if (mounted) setJoinLink(finalLink);
        } catch (e: any) {
          console.warn('[join-link error]', e);
          if (mounted) setLinkMsg(`URL生成エラー: ${e?.message || e}`);
        } finally {
          if (mounted) setLinkLoading(false);
        }
      } finally {
        setLoading(false);
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
    const text = `参加用URL\n${joinLink}`;
    const url = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // QR生成
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
    a.download = 'muverse-join-qr.png';
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
            <div className="page-sub">{profileState.REcode || '—'}</div>
          </div>
        </section>

        <UserProfile profile={profileState} isMyPage />

        {/* 参加URL */}
        <section className="profile-card" style={{ marginTop: 12 }}>
          <h2 className="section-title" style={{ margin: '0 0 8px' }}>参加用URL</h2>

          {linkLoading && <p style={{ margin: 0 }}>URL を準備中...</p>}
          {!linkLoading && linkMsg && (
            <p style={{ color: '#b91c1c', margin: 0 }}>{linkMsg}</p>
          )}

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
                <div style={{ fontSize: 12, wordBreak: 'break-all', color: '#111827' }}>
                  {joinLink}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="settings-btn" onClick={shareViaLINE}>
                    💚 LINEで共有
                  </button>
                  <button
                    className="settings-btn"
                    onClick={async () => { if (joinLink) await navigator.clipboard.writeText(joinLink); }}
                  >
                    📋 リンクをコピー
                  </button>
                </div>
                <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>
                  ※ 必要に応じて LIFF の「トーク選択」UIへ切替可能です。
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
          <Link href="/mypage/settings" className="settings-btn">
            ⚙️ 設定
          </Link>
        </div>
      </div>
    </div>
  );
}
