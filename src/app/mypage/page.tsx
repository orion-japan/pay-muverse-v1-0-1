// src/app/mypage/page.tsx
'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { getAuth, onAuthStateChanged, User } from 'firebase/auth';
import QRCode from 'qrcode';

// ✅ コンポーネントと型を同じバレルから import して“型の二重化”を防ぐ
import { UserProfile, type Profile } from '@/components/UserProfile'
import './mypage.css';

export default function MyPage() {
  const [profileState, setProfileState] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  // ▼ 招待リンク関連の状態
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState<boolean>(false);
  const [inviteMsg, setInviteMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // ▼ 追加：個別コピー表示用 & QR 用
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const qrCanvasRef = useRef<HTMLCanvasElement | null>(null);

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
          } catch {
            /* noop */
          }
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
          // ✅ types.ts で optional にしているので型エラーにならない
          REcode: p?.REcode ?? '',
        };

        if (mounted) setProfileState(profileForUI);

        // ▼ 招待リンクの取得（LINE共有・QR生成用）
        setInviteLoading(true);
        try {
          const r = await fetch('/api/my/invite-info', {
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`, // サーバ側で解決する実装の場合
            },
          });
          const j = await r.json();
          if (!r.ok) throw new Error(j?.error || 'failed to get invite link');
          if (mounted) setInviteLink(j?.link || null);
        } catch (e: any) {
          if (mounted) setInviteMsg(`招待リンク取得エラー: ${e?.message || e}`);
        } finally {
          if (mounted) setInviteLoading(false);
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

  // ▼ 汎用コピー
  const copyText = async (text: string, key?: string) => {
    await navigator.clipboard.writeText(text);
    if (key) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    } else {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  // ▼ LINE共有（LIFF不要のシンプル版）
  const shareViaLINE = () => {
    if (!inviteLink) return;
    const title = profileState?.name ? `${profileState.name} からの招待` : '招待リンク';
    const text = `${title}\n${inviteLink}`;
    const url = `https://line.me/R/msg/text/?${encodeURIComponent(text)}`;
    window.open(url, '_blank', 'noopener,noreferrer');
  };

  // ▼ リンクコピー（ショートハンド）
  const copyInviteLink = async () => {
    if (!inviteLink) return;
    await copyText(inviteLink);
  };

  // ▼ 招待リンクが更新されたら QR を生成
  useEffect(() => {
    if (!inviteLink || !qrCanvasRef.current) return;
    QRCode.toCanvas(qrCanvasRef.current, inviteLink, { width: 240, margin: 1 }, (err) => {
      if (err) console.error('QR gen error:', err);
    });
  }, [inviteLink]);

  // ▼ QR を PNG でダウンロード
  const downloadQR = () => {
    if (!qrCanvasRef.current) return;
    const url = qrCanvasRef.current.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invite-qr.png';
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

  // ▼ inviteLink から rcode/mcode/group を抽出（個別コピー用）
  const rcode = inviteLink ? new URL(inviteLink).searchParams.get('rcode') || '' : '';
  const mcode = inviteLink ? new URL(inviteLink).searchParams.get('mcode') || '' : '';
  const group = inviteLink ? new URL(inviteLink).searchParams.get('group') || '' : '';

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

        {/* ▼ 👇 招待ブロックを「1段上げ」= 編集/設定ボタンの“上”に配置 */}
        <section className="profile-card" style={{ marginTop: 12 }}>
          <h2 className="section-title" style={{ margin: '0 0 8px' }}>招待</h2>

          {inviteLoading && <p style={{ margin: 0 }}>招待リンクを準備中...</p>}
          {!inviteLoading && inviteMsg && (
            <p style={{ color: '#b91c1c', margin: 0 }}>{inviteMsg}</p>
          )}

          {!inviteLoading && inviteLink && (
            <div style={{ display: 'grid', gap: 10 }}>
              {/* 1) リンク本体 + コピー / LINE共有 */}
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
                  {inviteLink}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    className="settings-btn"
                    onClick={shareViaLINE}
                    title="LINEに招待を送る"
                  >
                    💚 LINEに招待を送る
                  </button>
                  <button className="settings-btn" onClick={copyInviteLink}>
                    📋 リンクをコピー
                  </button>
                  {copied && (
                    <span style={{ fontSize: 12, color: '#059669' }}>✓ コピーしました</span>
                  )}
                </div>
                <p style={{ margin: 0, fontSize: 11, color: '#6b7280' }}>
                  ※ LINE公式LIFFの「トーク選択」UIが必要なら後で切替可能です（LIFF Target Picker）。
                </p>
              </div>

              {/* 2) コード群（押しやすいチップ + 個別コピー） */}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {[
                  { label: 'ref', value: profileState.user_code },
                  { label: 'rcode', value: rcode },
                  { label: 'mcode', value: mcode },
                  { label: 'group', value: group },
                ]
                  .filter((x) => x.value)
                  .map((x) => (
                    <button
                      key={x.label}
                      onClick={() => copyText(String(x.value), x.label)}
                      title={`${x.label} をコピー`}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        border: '1px solid #e5e7eb',
                        background: '#ffffff',
                        padding: '6px 10px',
                        borderRadius: 9999,
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ color: '#6b7280' }}>{x.label}</span>
                      <strong style={{ color: '#111827' }}>{x.value}</strong>
                      <span>📋</span>
                      {copiedKey === x.label && (
                        <span style={{ fontSize: 11, color: '#059669' }}>✓</span>
                      )}
                    </button>
                  ))}
              </div>

              {/* 3) QRコード + ダウンロード */}
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
