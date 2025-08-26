'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';

const FOOTER_H = 60;

// ↓ 既存を活かしつつ Sofia を優先
const TENANT =
  (process.env.NEXT_PUBLIC_TENANT ?? '').toLowerCase() ||
  (typeof window !== 'undefined' && window.location.host.startsWith('s.') ? 'sofia' : 'mu');

const MU_UI_URL =
  (process.env.NEXT_PUBLIC_MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '');
const SOFIA_UI_URL =
  (process.env.NEXT_PUBLIC_SOFIA_UI_URL ?? 'https://s.muverse.jp').replace(/\/+$/, '');
const TARGET_UI_URL = TENANT === 'sofia' ? SOFIA_UI_URL : MU_UI_URL;

export default function MuFullPage() {
  const { user, loading } = useAuth();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const startMuAi = async () => {
      if (loading) return;
      if (!user) {
        setError('Firebase未ログインです');
        return;
      }
      try {
        const idToken = await user.getIdToken(true);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);

        const res = await fetch('/api/resolve-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken, tenant: TENANT }),
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timer);

        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.ok) throw new Error(json?.error || 'RESOLVE_FAILED');

        const loginUrl: string | undefined = json?.login_url;
        const userCode: string | undefined = json?.user_code;

        if (!loginUrl) {
          if (!userCode) throw new Error('署名付きURLが取得できませんでした');
          const fallback =
            `${TARGET_UI_URL}${TARGET_UI_URL.includes('?') ? '&' : '?'}` +
            `user=${encodeURIComponent(userCode)}`;
          setUrl(fallback);
        } else {
          setUrl(loginUrl);
        }
      } catch (e: any) {
        setError(e?.message || '不明なエラー');
      }
    };

    startMuAi();
  }, [user, loading]);

  if (error) {
    return (
      <div style={{ height: `calc(100dvh - ${FOOTER_H}px)`, display: 'grid', placeItems: 'center', color: 'red', fontWeight: 'bold' }}>
        エラー: {error}
      </div>
    );
  }

  if (!url) {
    return (
      <div style={{ height: `calc(100dvh - ${FOOTER_H}px)`, display: 'grid', placeItems: 'center' }}>
        {TENANT === 'sofia' ? 'Sofia_AI を開始中…' : 'Mu_AI を開始中…'}
      </div>
    );
  }

  // ★ ここがポイント：固定配置で full-bleed
  return (
    <div>
      <div
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: FOOTER_H, // フッター分だけ空ける
          width: '100vw',
          height: `calc(100vh - ${FOOTER_H}px)`,
          margin: 0,
          padding: 0,
          overflow: 'hidden',
          zIndex: 0,
        }}
      >
        <iframe
          src={url}
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          allow="clipboard-write; microphone; camera"
        />
      </div>
    </div>
  );
}
