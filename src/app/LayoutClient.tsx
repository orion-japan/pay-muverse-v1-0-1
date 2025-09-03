// src/app/LayoutClient.tsx
'use client'

import Footer from '../components/Footer'
import Header from '../components/Header'
import LoginModal from '../components/LoginModal'
import { usePathname } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { registerPush } from '@/utils/push'
import { createPortal } from 'react-dom'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ensureSessionId,
  startHeartbeat,
  stopHeartbeat,
  wireOnlineOffline,
  tracePage,
  tlog, // ★ 追加
} from '@/lib/telemetry'

/* =========================
   Portal 先のフッター高さを“確実に”取得して
   CSS 変数（--footer-h / --footer-safe-pad）を更新するフック
   ========================= */
function usePortalFooterPadding(enabled: boolean) {
  const roRef = useRef<ResizeObserver | null>(null)

  useLayoutEffect(() => {
    if (!enabled) {
      document.documentElement.style.setProperty('--footer-h', '0px')
      document.documentElement.style.setProperty('--footer-safe-pad', '0px')
      return
    }

    const update = () => {
      const footerRoot = document.getElementById('mu-footer-root')
      if (!footerRoot) return
      const h = Math.max(0, Math.round(footerRoot.getBoundingClientRect().height || 0))
      document.documentElement.style.setProperty('--footer-h', `${h}px`)
      document.documentElement.style.setProperty(
        '--footer-safe-pad',
        `calc(${h}px + env(safe-area-inset-bottom))`
      )
    }

    // 初回
    update()

    const footerEl = document.getElementById('mu-footer-root')
    if (footerEl && 'ResizeObserver' in window) {
      roRef.current = new ResizeObserver(update)
      roRef.current.observe(footerEl)
    }
    window.addEventListener('resize', update)

    return () => {
      window.removeEventListener('resize', update)
      if (roRef.current && footerEl) roRef.current.unobserve(footerEl)
    }
  }, [enabled])
}

/** Footer を <body> 直下に描画するラッパー（マウント後のみ） */
function FooterPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  if (!mounted) return null

  let host = document.getElementById('mu-footer-root') as HTMLElement | null
  if (!host) {
    host = document.createElement('div')
    host.id = 'mu-footer-root'
    document.body.appendChild(host)
  }
  return createPortal(children, host)
}

function LayoutBody({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false)
  const [mounted, setMounted] = useState(false)
  const pathname = usePathname()

  useEffect(() => setMounted(true), [])

  const isCredit = pathname?.startsWith('/credit') === true
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true
  const isIros = pathname?.startsWith('/iros') === true
  const isSofia = pathname?.startsWith('/sofia') === true

  // ★ /credit 以外はフッターの高さを測って CSS 変数を更新（/sofia も含める）
  usePortalFooterPadding(!isCredit)

  // main の padding-bottom（/credit だけ 0、/sofia でもフッター高さぶん確保）
  const mainPad = useMemo(
    () => (isCredit ? '0' : 'var(--footer-safe-pad, 56px)'),
    [isCredit]
  )

  return (
    <>
      {/* /mu_ai, /mu_full, /iros, /sofia では PAY 側ヘッダー非表示 */}
      {!(isMuAI || isIros || isSofia) && mounted && (
        <Header onLoginClick={() => setShowLogin(true)} />
      )}

      <main
        className={`mu-main ${isMuAI ? 'mu-main--wide' : ''}`}
        style={{
          flex: '1 1 auto',
          overflowY: 'auto',
          WebkitOverflowScrolling: 'touch',
          paddingBottom: mainPad,
        }}
      >
        <div className={`mu-page ${isMuAI ? 'mu-page--wide' : ''}`}>{children}</div>
      </main>

      {/* ★ /credit 以外はフッターを表示（/sofia も表示） */}
      {!isCredit && mounted && (
        <FooterPortal>
          <Footer />
        </FooterPortal>
      )}

      {/* ヘッダー由来のモーダル → ヘッダーを出さないページでは非表示（/sofia も非表示） */}
      {!(isMuAI || isIros || isSofia) && mounted && (
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
  const isIros = pathname?.startsWith('/iros') === true
  const isSofia = pathname?.startsWith('/sofia') === true

  // ★ 監視記録（テレメトリ）起動：セッション生成・HB・オンライン監視
  useEffect(() => {
    ensureSessionId()
    const unbind = wireOnlineOffline()

    // ← 初回に一度だけ、どのパスから始まったかを明示ログ
    tlog({
      kind: 'online',
      path: 'heartbeat_start',
      note: JSON.stringify({ first_path: pathname }),
    })

    // HB は 1引数だけでOK（第2引数は使わない）
    startHeartbeat(30000)

    return () => {
      unbind?.()
      stopHeartbeat()
    }
    // 初回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ★ ページ遷移のトレース
  useEffect(() => {
    tracePage(pathname || '/')
  }, [pathname])

  // SW 登録＋フォールバック受信＋subscription 登録（副作用のみ）
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

    return () => {
      if (onMsg) navigator.serviceWorker.removeEventListener('message', onMsg)
    }
  }, [userCode])

  return (
    <div className={`app-container ${isMuAI ? 'mu-ai' : ''}`} suppressHydrationWarning>
      <LayoutBody>{children}</LayoutBody>
    </div>
  )
}
