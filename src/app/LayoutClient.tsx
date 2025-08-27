'use client'

import Footer from '../components/Footer'
import Header from '../components/Header'
import LoginModal from '../components/LoginModal'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { registerPush } from '@/utils/push'
import { createPortal } from 'react-dom'

/** Footer を <body> 直下に描画する薄いラッパー（レイアウトは従来のまま） */
function FooterPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null
  return createPortal(children, document.body)
}

function LayoutBody({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false)
  const pathname = usePathname()

  const isCredit = pathname?.startsWith('/credit') === true
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true

  return (
    <>
      {!isMuAI && <Header onLoginClick={() => setShowLogin(true)} />}

      {/* 下余白は CSS 変数 --footer-h を利用（isCredit= true のときだけ 0） */}
      <main
        className={`mu-main ${isMuAI ? 'mu-main--wide' : ''}`}
        style={{ paddingBottom: isCredit ? 0 : 'calc(var(--footer-h, 56px) + 12px)' }}
      >
        <div className={`mu-page ${isMuAI ? 'mu-page--wide' : ''}`}>{children}</div>
      </main>

      {/* フッターは構造を崩さず Portal で body 直下へ（位置ズレ防止） */}
      {!isCredit && (
        <FooterPortal>
          <Footer />
        </FooterPortal>
      )}

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
  div.onclick = () => {
    window.location.href = url || '/'
    div.remove()
  }
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 8000)
}

export default function LayoutClient({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { userCode } = useAuth()
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true

  // SW 登録＋フォールバック受信＋subscription 登録
  useEffect(() => {
    let onMsg: ((e: MessageEvent) => void) | null = null
    ;(async () => {
      if (!('serviceWorker' in navigator)) return
      const reg = await navigator.serviceWorker.register('/sw.js')
      console.log('✅ Service Worker registered:', reg)

      if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
        try { await Notification.requestPermission() } catch {}
      }

      if (userCode) {
        try {
          const res = await registerPush(userCode)
          console.log('✅ Push subscription registered:', res)
        } catch (err) {
          console.error('❌ registerPush failed:', err)
        }
      }

      onMsg = (e: MessageEvent) => {
        const msg = e?.data
        if (msg?.type === 'PUSH_FALLBACK') {
          showToast(msg.title ?? 'お知らせ', msg.body ?? '', msg.url ?? '/')
        }
      }
      navigator.serviceWorker.addEventListener('message', onMsg)
    })().catch((err) => console.error('❌ Service Worker setup failed:', err))

    return () => { if (onMsg) navigator.serviceWorker.removeEventListener('message', onMsg) }
  }, [userCode])

  return (
    <div className={isMuAI ? 'mu-ai' : ''}>
      <LayoutBody>{children}</LayoutBody>
    </div>
  )
}
