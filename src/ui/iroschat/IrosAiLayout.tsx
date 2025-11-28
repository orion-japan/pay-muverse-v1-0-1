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
import { useIrosChat } from './IrosChatContext'; // ★ 追加：Future-Seed 呼び出し用

/**
 * Iros-AI 専用レイアウト
 */
export default function IrosAiLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [showLogin, setShowLogin] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [seedActive, setSeedActive] = useState(false); // Seed準備中インジケータ

  const { userCode } = useAuth(); // ログイン状態を取得
  const { sendFutureSeed } = useIrosChat(); // ★ Future-Seed API 呼び出し
  const router = useRouter();

  // ★ ログアウト処理
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

  // ★ Seed ボタンクリック → /api/agent/iros/future-seed を叩いて Seed メッセージ追加
  const handleSeedClick = async () => {
    if (seedActive) return; // 連打防止

    // ログインしていなければ、まずログインモーダルを開く
    if (!userCode) {
      setShowLogin(true);
      return;
    }

    console.log('[IROS] Seed ボタンが押されました（Future-Seed 起動）');
    setSeedActive(true);

    try {
      const result = await sendFutureSeed();
      console.log('[IROS] Future-Seed result', result);
      // sendFutureSeed 内で setMessages 済みなので、ここではログだけ
      if (!result) {
        console.warn('[IROS] Future-Seed: 応答が空でした');
      }
    } catch (e) {
      console.error('[IROS] Future-Seed 呼び出し中にエラー', e);
    } finally {
      setTimeout(() => setSeedActive(false), 600);
    }
  };

  return (
    <div className={styles.root}>
      {/* ===== 上部ヘッダー ===== */}
      <header
        aria-label="Iros-AI header"
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2000,
        }}
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

          <nav
            style={{
              display: 'flex',
              gap: '10px',
              alignItems: 'center',
            }}
          >
            {/* ⚙ メニューアイコン（ドロップダウン） */}
            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
              }}
            >
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
                {/* 三本線アイコン */}
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
                    top: 70, // ヘッダーのすぐ下あたり
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
                      {/* 設定（ログイン中） */}
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

                      {/* ログアウト */}
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
                      {/* ログイン（モーダル） */}
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

                      {/* 設定リンク（未ログインでもOK） */}
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

            {/* ★ Seed 状態の小さな表示 */}
            {seedActive && (
              <span
                style={{
                  fontSize: '0.75rem',
                  color: '#4F46E5',
                  opacity: 0.9,
                  whiteSpace: 'nowrap',
                }}
              >
                Seed 準備中…
              </span>
            )}

            {/* 🌱 Seed ボタン（Future-Seed 実行） */}
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
              Seed
            </button>
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
