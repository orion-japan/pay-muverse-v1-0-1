'use client'

import './globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import Header from '../components/Header'
import LoginModal from '../components/LoginModal' // ← 追加（既存のモーダルを使用）
import { AuthProvider } from '@/context/AuthContext'
import { useState, useEffect } from 'react'
import { usePathname } from 'next/navigation'

function LayoutBody({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false)
  const pathname = usePathname()

  // ルートごとの表示制御
  const isCredit = pathname?.startsWith('/credit') === true
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true // 将来の全幅ページも拾う

  return (
    <>
      {/* Mu系ページではヘッダー非表示 */}
      {!isMuAI && <Header onLoginClick={() => setShowLogin(true)} />}

      {/* 通常は 430px 中央寄せ。Mu系だけ全幅化 */}
      <main
        className={`mu-main ${isMuAI ? 'mu-main--wide' : ''}`}
        style={{ paddingBottom: isCredit ? 0 : 60 }}
      >
        {/* セクション安全ラッパ。Mu系は全幅 */}
        <div className={`mu-page ${isMuAI ? 'mu-page--wide' : ''}`}>
          {children}
        </div>
      </main>

      {/* クレジットだけはフッターを消す（iframe が全高を使うため） */}
      {!isCredit && <Footer />}

      {/* ログインモーダル（Mu系では呼ばれない／Header から開く） */}
      {!isMuAI && (
        <LoginModal
          isOpen={showLogin}
          onClose={() => setShowLogin(false)}
          onLoginSuccess={() => setShowLogin(false)}
        />
      )}
    </>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true

  // 🚀 Service Worker 登録処理
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/sw.js')
        .then((reg) => {
          console.log('✅ Service Worker registered:', reg)
        })
        .catch((err) => {
          console.error('❌ Service Worker registration failed:', err)
        })
    }
  }, [])

  return (
    <html lang="ja">
      {/* body にもフラグクラスを付与して CSS 側で切替しやすく */}
      <body className={isMuAI ? 'mu-ai' : ''} style={{ margin: 0 }}>
        {/* アプリ全体を認証コンテキストで包む */}
        <AuthProvider>
          <LayoutBody>{children}</LayoutBody>
        </AuthProvider>
      </body>
    </html>
  )
}
