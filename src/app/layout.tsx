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

/** ページ内トースト（通知が出せないときのフォールバック） */
function showToast(title: string, body: string, url: string) {
  // 既存を消す
  const old = document.querySelector('#mu-push-toast')
  if (old) old.remove()

  const div = document.createElement('div')
  div.id = 'mu-push-toast'
  div.style.cssText = `
    position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
    max-width: 320px; padding: 12px 14px; border-radius: 12px;
    background: rgba(30,30,30,0.95); color: #fff; box-shadow: 0 6px 24px rgba(0,0,0,.25);
    font-family: system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif;
    cursor: pointer;
  `
  div.innerHTML = `
    <div style="font-weight:600; margin-bottom:6px; font-size:14px;">${title ?? 'お知らせ'}</div>
    <div style="opacity:.9; font-size:13px; line-height:1.4;">${body ?? ''}</div>
  `
  div.onclick = () => { window.location.href = url || '/'; div.remove() }
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 8000)
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true

  // 🚀 Service Worker 登録 + 通知権限 + フォールバック受信
  useEffect(() => {
    let onMsg: ((e: MessageEvent) => void) | null = null

    ;(async () => {
      if (!('serviceWorker' in navigator)) return

      // SW を登録
      const reg = await navigator.serviceWorker.register('/sw.js')
      console.log('✅ Service Worker registered:', reg)

      // 通知権限が未決なら一度だけ要求
      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try { await Notification.requestPermission() } catch {}
      }

      // SW→Window のフォールバック通知を受けてトースト表示
      onMsg = (e: MessageEvent) => {
        const msg = e?.data
        if (msg?.type === 'PUSH_FALLBACK') {
          showToast(msg.title ?? 'お知らせ', msg.body ?? '', msg.url ?? '/')
        }
      }
      navigator.serviceWorker.addEventListener('message', onMsg)
    })().catch((err) => {
      console.error('❌ Service Worker setup failed:', err)
    })

    return () => {
      if (onMsg) navigator.serviceWorker.removeEventListener('message', onMsg)
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
