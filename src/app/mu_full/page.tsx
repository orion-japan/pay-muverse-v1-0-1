'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext'; // Firebase認証用のContext

const FOOTER_H = 60;
// 既存の環境変数は残す（フォールバック用・ログ用）
const MU_UI_URL = (process.env.NEXT_PUBLIC_MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '');

export default function MuFullPage() {
  const { user, loading } = useAuth();
  const [url, setUrl] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const startMuAi = async () => {
      console.log('========== [mu_full] ページロード開始 ==========');
      console.log('[mu_full] Firebase認証状態:', { loading, hasUser: !!user });

      if (loading) {
        console.log('[mu_full] ⏳ Firebase認証状態取得中 → 待機');
        return;
      }
      if (!user) {
        console.error('[mu_full] ❌ Firebase未ログイン → 処理中断');
        setError('Firebase未ログインです');
        return;
      }

      try {
        console.log('[mu_full] 🔍 Firebase IDトークン取得開始');
        const idToken = await user.getIdToken(true); // 常に鮮度確保
        if (!idToken) throw new Error('IDトークン取得失敗');
        console.log('[mu_full] ✅ Firebase IDトークン取得OK（長さ）:', idToken.length);

        // === 署名付きURLは PAY 側で生成する ===
        console.log('[mu_full] 📡 /api/resolve-user 呼び出し開始');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12000);

        const res = await fetch('/api/resolve-user', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
          cache: 'no-store',
          signal: controller.signal,
        }).catch((e) => {
          console.error('[mu_full] ❌ fetch失敗', e);
          throw e;
        });

        clearTimeout(timer);

        console.log('[mu_full] 📥 /api/resolve-user ステータス:', res.status);
        const json = await res.json().catch(() => ({}) as any);

        if (!res.ok || !json?.ok) {
          console.error('[mu_full] ❌ resolve-user 応答エラー:', json);
          throw new Error(json?.error || 'RESOLVE_FAILED');
        }

        // PAY 側で署名済みの完成URL
        const loginUrl: string | undefined = json?.login_url;
        const userCode: string | undefined = json?.user_code;

        if (!loginUrl) {
          // 念のためのフォールバック（通常は到達しない想定）
          if (!userCode) {
            throw new Error('署名付きURLが取得できませんでした');
          }
          const fallback =
            `${MU_UI_URL}${MU_UI_URL.includes('?') ? '&' : '?'}` +
            `user=${encodeURIComponent(userCode)}`;
          console.warn('[mu_full] ⚠️ login_url欠落 → フォールバックURLを使用:', fallback);
          setUrl(fallback);
        } else {
          console.log('[mu_full] ✅ MU 署名付きURL 取得OK:', loginUrl);
          setUrl(loginUrl);
        }

        console.log('[mu_full] 🎯 iframe URL セット完了');
      } catch (err: any) {
        console.error('[mu_full] ❌ MU起動処理失敗:', err);
        setError(err?.message || '不明なエラー');
      } finally {
        console.log('========== [mu_full] ページロード処理終了 ==========');
      }
    };

    startMuAi();
  }, [user, loading]);

  // エラー表示
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

  // ローディング表示
  if (!url) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Mu_AI を開始中…
      </div>
    );
  }

  // ログイン後（iframe表示）
  return (
    <div
      style={{
        height: `calc(100dvh - ${FOOTER_H}px)`,
        margin: 0,
        padding: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <iframe
        src={url}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
        allow="clipboard-write; microphone; camera"
      />
    </div>
  );
}
