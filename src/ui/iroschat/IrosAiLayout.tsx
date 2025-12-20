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
import { useIrosChat } from './IrosChatContext';

export default function IrosAiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showLogin, setShowLogin] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  // そのまま使ってOK（renameは後で）
  const [seedActive, setSeedActive] = useState(false);

  const { userCode } = useAuth();
  const { sendMessage } = useIrosChat(); // ✅ ここを sendFutureSeed → sendMessage に
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    } catch {
    } finally {
      try {
        await signOut(auth);
      } catch {}
      router.refresh();
      setShowMenu(false);
    }
  };

  // ✅ 右上ボタン：押したら「選択肢」を user 発話として送り、NextStep を出させる
  const handleSeedClick = async () => {
    if (seedActive) return;

    if (!userCode) {
      setShowLogin(true);
      return;
    }

    setSeedActive(true);
    try {
      console.log('[IROS] 選択ボタン → 選択肢トリガー送信');
      await sendMessage('選択肢', 'nextStep'); // ★ 演出の核
    } catch (e) {
      console.error('[IROS] 選択肢トリガー送信でエラー', e);
    } finally {
      setTimeout(() => setSeedActive(false), 600);
    }
  };

  return (
    <div className={styles.root}>
      <header
        aria-label="Iros-AI header"
        style={{ position: 'sticky', top: 0, zIndex: 2000 }}
      >
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

          <nav style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
            {/* ⚙ メニュー（そのまま） */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <button
                type="button"
                onClick={() => setShowMenu((v) => !v)}
                aria-haspopup="true"
                aria-expanded={showMenu}
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '999px',
                  border: '1px solid rgba(0,0,0,0.15)',
                  background: '#ffffff',
                  cursor: 'pointer',
                  fontSize: '1rem',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 0,
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: 14,
                    height: 2,
                    background: '#111827',
                    borderRadius: 999,
                    position: 'relative',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: -5,
                      width: 14,
                      height: 2,
                      borderRadius: 999,
                      background: '#111827',
                    }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 5,
                      width: 14,
                      height: 2,
                      borderRadius: 999,
                      background: '#111827',
                    }}
                  />
                </span>
              </button>

              {showMenu && (
                <div
                  style={{
                    position: 'fixed',
                    top: 70,
                    right: 24,
                    background: '#ffffff',
                    borderRadius: 12,
                    border: '1px solid rgba(0,0,0,0.08)',
                    boxShadow: '0 8px 24px rgba(15,23,42,0.18)',
                    padding: '6px 0',
                    minWidth: 150,
                    zIndex: 9999,
                  }}
                >
                  {userCode ? (
                    <>
                      <Link
                        href="/iros-ai/settings"
                        onClick={() => setShowMenu(false)}
                        style={{
                          display: 'block',
                          padding: '8px 14px',
                          fontSize: '0.85rem',
                          textDecoration: 'none',
                          color: '#111827',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        設定
                      </Link>

                      <button
                        type="button"
                        onClick={handleLogout}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 14px',
                          fontSize: '0.85rem',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        ログアウト
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setShowMenu(false);
                          setShowLogin(true);
                        }}
                        style={{
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 14px',
                          fontSize: '0.85rem',
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        ログイン
                      </button>

                      <Link
                        href="/iros-ai/settings"
                        onClick={() => setShowMenu(false)}
                        style={{
                          display: 'block',
                          padding: '8px 14px',
                          fontSize: '0.85rem',
                          textDecoration: 'none',
                          color: '#111827',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        設定
                      </Link>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* 動作中表示 */}
            {seedActive && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: '#4F46E5',
                  opacity: 0.9,
                  whiteSpace: 'nowrap',
                }}
              >
                選択肢 準備中…
              </span>
            )}

            {/* ✅ Seed → 選択 */}
            <button
              type="button"
              onClick={handleSeedClick}
              style={{
                padding: '6px 16px',
                borderRadius: 999,
                border: 'none',
                background: '#4F46E5',
                color: '#ffffff',
                cursor: seedActive ? 'default' : 'pointer',
                fontSize: '0.85rem',
                whiteSpace: 'nowrap',
                opacity: seedActive ? 0.7 : 1,
              }}
              disabled={seedActive}
            >
              選択
            </button>
          </nav>
        </div>
      </header>

      <main className={styles.content} aria-label="Iros-AI content">
        {children}
      </main>

      <LoginModal
        isOpen={showLogin}
        onClose={() => setShowLogin(false)}
        onLoginSuccess={() => setShowLogin(false)}
      />
    </div>
  );
}
