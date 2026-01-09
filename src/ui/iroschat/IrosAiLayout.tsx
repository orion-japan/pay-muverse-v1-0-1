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

export default function IrosAiLayout({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false);
  const [showMenu, setShowMenu] = useState(false);

  const { userCode } = useAuth();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    } catch {
      // ignore
    } finally {
      try {
        await signOut(auth);
      } catch {}
      router.refresh();
      setShowMenu(false);
    }
  };

  return (
    <div className={styles.root}>
      <header aria-label="Iros-AI header" style={{ position: 'sticky', top: 0, zIndex: 2000 }}>
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

          {/* ✅ 右端：メニューのみ（選択ボタンは削除） */}
          <nav style={{ display: 'flex', alignItems: 'center' }}>
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
                    right: 18, // ✅ 右端に寄せる
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
