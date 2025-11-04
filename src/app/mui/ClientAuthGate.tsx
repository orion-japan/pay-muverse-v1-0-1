'use client';

import React from 'react';
import MuiChat from '@/components/mui/MuiChat';

/** 既存モーダルを起動する汎用ボタン（実装がどれでも拾えるように複数トリガ） */
export function LoginModalButton() {
  const openModal = React.useCallback(() => {
    const w = globalThis as any;
    if (typeof w.openLoginModal === 'function') return w.openLoginModal();
    if (typeof w.__OPEN_LOGIN__ === 'function') return w.__OPEN_LOGIN__();
    try {
      document.dispatchEvent(new CustomEvent('open-login'));
      document.dispatchEvent(new CustomEvent('openAuthModal'));
    } catch {}
  }, []);
  return (
    <button className="btn" onClick={openModal}>
      ログイン（モーダルを開く）
    </button>
  );
}

function isClientLoggedIn(): boolean {
  const w = globalThis as any;
  // 1) window.__USER_CODE__ が ANON 以外
  if (w?.__USER_CODE__ && w.__USER_CODE__ !== 'ANON') return true;
  // 2) ローカルストレージで保持している場合（任意）
  const ls = typeof localStorage !== 'undefined' ? localStorage.getItem('USER_CODE') : null;
  if (ls && ls !== 'ANON') return true;
  return false;
}

/**
 * クライアント側で Firebase / window.__USER_CODE__ を監視し、
 * いずれかでログインを検知したら <MuiChat /> を表示。
 */
export function ClientAuthGate({ children }: { children: React.ReactNode }) {
  const [ok, setOk] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let unsubFirebase: (() => void) | null = null;
    let pollId: any = null;

    const decide = async () => {
      // A) window.__USER_CODE__ / localStorage
      if (isClientLoggedIn()) {
        setOk(true);
        return;
      }

      // B) Firebase currentUser / onAuthStateChanged
      try {
        const app = (await import('firebase/app')).getApps?.()[0] ?? null;
        if (app) {
          const { getAuth, onAuthStateChanged } = await import('firebase/auth');
          const auth = getAuth();
          if (auth?.currentUser) {
            setOk(true);
            return;
          }
          unsubFirebase = onAuthStateChanged(auth, (u) => {
            if (u) setOk(true);
          });
        }
      } catch {
        /* SDK 未ロードは無視 */
      }

      // C) 既存実装がモーダル完了時に発火できるフック
      const onLoginEvent = () => setOk(true);
      document.addEventListener('auth:login', onLoginEvent);
      document.addEventListener('auth-login', onLoginEvent);
      // 予防的に 1.5秒間隔で __USER_CODE__ を軽くポーリング（すぐ止まる）
      pollId = setInterval(() => {
        if (isClientLoggedIn()) {
          setOk(true);
        }
      }, 1500);

      // クリーンアップ
      return () => {
        if (unsubFirebase) unsubFirebase();
        document.removeEventListener('auth:login', onLoginEvent);
        document.removeEventListener('auth-login', onLoginEvent);
        if (pollId) clearInterval(pollId);
      };
    };

    // 初期判定
    decide().then(() => {
      // 初期で既に true の場合はポーリング等を止める
      if (ok === true && pollId) clearInterval(pollId);
    });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 初回レンダのチラつき防止
  if (ok === null) return <div style={{ padding: 24 }} />;

  return ok ? <MuiChat /> : <>{children}</>;
}
