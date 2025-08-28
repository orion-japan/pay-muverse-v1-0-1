// src/app/iros/page.tsx
'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';

const FOOTER_H = 60;

// ★ /iros は SOFIA 固定
const TENANT: 'sofia' = 'sofia';

const MU_UI_URL =
  (process.env.NEXT_PUBLIC_MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '');
const SOFIA_UI_URL =
  (process.env.NEXT_PUBLIC_SOFIA_UI_URL ?? 'https://s.muverse.jp').replace(/\/+$/, '');
const TARGET_UI_URL = SOFIA_UI_URL; // ← /iros は常に SOFIA をターゲット

export default function IrosPage() {
  const { user, loading } = useAuth();
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const start = async () => {
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

        // ① ベースURLを決定（login_url 優先、なければフォールバック）
        let base = loginUrl;
        if (!base) {
          if (!userCode) throw new Error('署名付きURLが取得できませんでした');
          base =
            `${TARGET_UI_URL}${TARGET_UI_URL.includes('?') ? '&' : '?'}` +
            `user=${encodeURIComponent(userCode)}`;
        }

        // ② 必ず s.muverse.jp を向ける（返ってきたURLが MU でも強制上書き）
        const u = new URL(base);
        const sofiaHost = new URL(SOFIA_UI_URL).host;
        u.protocol = 'https:'; // 念のため
        u.host = sofiaHost;

        // ③ iFrame用オプション（MU/SO側対応済みならヘッダー非表示）
        u.searchParams.set('hideHeader', '1');

        setUrl(u.toString());
      } catch (e: any) {
        setError(e?.message || '不明なエラー');
      }
    };

    start();
  }, [user, loading]);

  if (error) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
          color: 'red',
          fontWeight: 'bold',
        }}
      >
        エラー: {error}
      </div>
    );
  }

  if (!url) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Sofia_AI を開始中…
      </div>
    );
  }

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
