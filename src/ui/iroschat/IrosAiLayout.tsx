// src/ui/iroschat/IrosAiLayout.tsx
'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { signOut } from 'firebase/auth';
import { auth } from '@/lib/firebase';
import { useAuth } from '@/context/AuthContext';
import styles from './index.module.css';
import LoginModal from '@/components/LoginModal';

/**
 * Iros-AI 専用レイアウト
 */
export default function IrosAiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showLogin, setShowLogin] = useState(false);
  const { userCode } = useAuth(); // ★ ログイン状態を取得
  const router = useRouter();

  // ★ ログアウト処理
  const handleLogout = async () => {
    try {
      // セッションCookie用の logout API がある前提
      // なければここは後で一緒に実装しましょう
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    } catch {
      // API 側は失敗しても、クライアント側は続行
    } finally {
      try {
        await signOut(auth);
      } catch {}
      router.refresh();
    }
  };

  return (
    <div className={styles.root}>
      {/* ===== 上部ヘッダー ===== */}
      <header aria-label="Iros-AI header">
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            padding: '45px 18px 16px',
            borderBottom: '1px solid rgba(0,0,0,0.08)',
            background: '#ffffff',
            minHeight: '68px',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontWeight: 600, fontSize: '1rem' }}>Iros AI</span>
            <span
              style={{
                fontSize: '0.72rem',
                opacity: 0.65,
                marginTop: 3,
                whiteSpace: 'nowrap',
              }}
            >
              Inner Mirror for your intention
            </span>
          </div>

          <nav
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            {/* ★ ログイン状態で出し分け */}
            {userCode ? (
              // ログイン中 → ログアウトボタン
              <button
                type="button"
                onClick={handleLogout}
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: '1px solid rgba(0,0,0,0.15)',
                  background: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                ログアウト
              </button>
            ) : (
              // 未ログイン → ログインモーダルを開く
              <button
                type="button"
                onClick={() => setShowLogin(true)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: '1px solid rgba(0,0,0,0.15)',
                  background: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                ログイン
              </button>
            )}

            {/* 設定ボタン → /iros-ai/settings へ遷移 */}
            <Link href="/iros-ai/settings">
              <button
                type="button"
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  border: 'none',
                  background: '#111827',
                  color: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '0.85rem',
                }}
              >
                設定
              </button>
            </Link>
          </nav>
        </div>
      </header>

      {/* ===== メインエリア ===== */}
      <main className={styles.content} aria-label="Iros-AI content">
        {children}
      </main>

      {/* ===== ログインモーダル ===== */}
      <LoginModal
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        onLoginSuccess={() => setShowLogin(false)}
      />
    </div>
  );
}
