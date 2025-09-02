// src/components/Footer.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const FALLBACK_H = 56
type ItemId = 'home' | 'talk' | 'board' | 'pay' | 'mypage'
type Item = { id: ItemId; label: string; href: string; icon?: React.ReactNode }

function toast(msg: string) {
  const id = 'mu-footer-toast'
  document.getElementById(id)?.remove()
  const div = document.createElement('div')
  div.id = id
  div.style.cssText =
    'position:fixed;left:50%;bottom:calc(12px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;' +
    'background:rgba(30,30,30,.92);color:#fff;padding:10px 12px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);' +
    'font:600 12px/1.2 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans JP",sans-serif'
  div.textContent = msg
  document.body.appendChild(div)
  setTimeout(() => div.remove(), 2200)
}

// Supabase シングルトン
function getSb(): SupabaseClient | null {
  if (typeof window === 'undefined') return null
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  const g = window as any
  if (!g.__sb_footer) g.__sb_footer = createClient(url, key)
  return g.__sb_footer as SupabaseClient
}

// デバッグ用バッジ (?debug_footer_badge=数字)
const getDebugBadge = () => {
  if (typeof window === 'undefined') return 0
  const v = new URLSearchParams(window.location.search).get('debug_footer_badge')
  return v ? Math.max(0, Number(v) || 0) : 0
}

export default function Footer() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  const router = useRouter()
  const pathname = usePathname()
  const { user, userCode } = useAuth()
  const isLoggedIn = !!user

  const [counts, setCounts] = useState<Record<ItemId, number>>({
    home: 0, talk: 0, board: 0, pay: 0, mypage: 0,
  })

  const debugBadge = useMemo(
    () => (process.env.NODE_ENV === 'development' ? getDebugBadge() : 0),
    []
  )

  useEffect(() => setMounted(true), [])

  // ポータル先
  useEffect(() => {
    let el = document.getElementById('mu-footer-root') as HTMLDivElement | null
    if (!el) {
      el = document.createElement('div')
      el.id = 'mu-footer-root'
      document.body.appendChild(el)
    }
    setHost(el)
  }, [])

  // 高さを CSS 変数に
  useEffect(() => {
    const setPad = (h: number) => {
      const px = Math.max(0, Math.round(h || 0))
      document.documentElement.style.setProperty('--footer-h', `${px}px`)
      document.documentElement.style.setProperty('--footer-safe-pad', `calc(${px}px + env(safe-area-inset-bottom))`)
    }
    setPad(FALLBACK_H)
    const el = navRef.current
    if (!el) return
    const update = () => setPad(el.getBoundingClientRect().height)
    update()
    const ro = 'ResizeObserver' in window ? new ResizeObserver(update) : null
    ro?.observe(el)
    window.addEventListener('resize', update)
    return () => { ro?.disconnect(); window.removeEventListener('resize', update) }
  }, [host, mounted])

  const items: Item[] = useMemo(() => [
    { id: 'home',   label: 'Home',    href: '/',       icon: <span>🏠</span> },
    { id: 'talk',   label: 'Talk',    href: '/talk',   icon: <span>💬</span> },
    { id: 'board',  label: 'I Board', href: '/board',  icon: <span>🧩</span> },
    { id: 'pay',    label: 'Plan',    href: '/pay',    icon: <span>💳</span> },
    { id: 'mypage', label: 'My Page', href: '/mypage', icon: <span>👤</span> },
  ], [])

  const onClick = (it: Item) => (e: React.MouseEvent) => {
    const isHome = it.href === '/'
    if (!isLoggedIn && !isHome) {
      e.preventDefault()
      toast('この機能はログインが必要です')
      return
    }
    e.preventDefault()
    if (pathname !== it.href) router.push(it.href)
  }

  // ===== 未読バッジ =====
  useEffect(() => {
    if (debugBadge > 0) { setCounts(c => ({ ...c, talk: debugBadge })); return }
    if (!isLoggedIn)   { setCounts(c => ({ ...c, talk: 0 }));        return }

    let timer: number | undefined
    const sb = getSb()
    const cleanups: Array<() => void> = []

    const setTalk = (n: number) => setCounts(c => (c.talk !== n ? { ...c, talk: n } : c))

    const load = async () => {
      try {
        let idToken: string | null = null
        try {
          const { getAuth } = await import('firebase/auth')
          const auth = getAuth()
          idToken = await auth.currentUser?.getIdToken().catch(() => null)
        } catch {}

        const res = await fetch('/api/talk/unread-count', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
          },
          cache: 'no-store',
        })
        if (!res.ok) { setTalk(0); return }
        const j = (await res.json().catch(() => null)) as { unread?: number } | null
        setTalk(Math.max(0, Number(j?.unread ?? 0)))
      } catch {
        setTalk(0)
      }
    }

    // 初回・定期・再表示
    load()
    timer = window.setInterval(load, 20000)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    cleanups.push(() => document.removeEventListener('visibilitychange', onVis))
    cleanups.push(() => timer && clearInterval(timer))

    // ページ間イベント
    const onBadge = (e: CustomEvent<{ total?: number }>) => {
      setTalk(Math.max(0, Number(e.detail?.total ?? 0)))
    }
    window.addEventListener('talk:badge', onBadge as unknown as EventListener)
    cleanups.push(() => window.removeEventListener('talk:badge', onBadge as unknown as EventListener))

    // localStorage 経由
    const onStorage = (ev: StorageEvent) => {
      if (ev.key === 'mu_talk_total_unread') {
        setTalk(Math.max(0, Number(ev.newValue ?? 0)))
      }
    }
    window.addEventListener('storage', onStorage)
    cleanups.push(() => window.removeEventListener('storage', onStorage))

    // Service Worker
    const onUpdated = () => load()
    window.addEventListener('talk:updated', onUpdated)
    cleanups.push(() => window.removeEventListener('talk:updated', onUpdated))
    if (navigator?.serviceWorker) {
      const swHandler = (e: MessageEvent) => { if ((e.data as any)?.type === 'talk:updated') load() }
      navigator.serviceWorker.addEventListener('message', swHandler as any)
      cleanups.push(() => navigator.serviceWorker.removeEventListener('message', swHandler as any))
    }

    // Realtime
    if (sb) {
      const ch1 = sb.channel(`rt-chats-footer`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'chats' },
          (payload) => {
            if (userCode && payload.new && payload.new['user_code'] === userCode) return
            load()
          }
        )
        .subscribe()
      cleanups.push(() => sb.removeChannel(ch1))

      const ch2 = sb.channel(`rt-reads-footer`)
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'conversation_reads' },
          (payload) => {
            if (payload.new && payload.new['user_code'] === userCode) load()
          }
        )
        .subscribe()
      cleanups.push(() => sb.removeChannel(ch2))
    }

    return () => { cleanups.forEach(fn => fn()) }
  }, [isLoggedIn, debugBadge, userCode])

  if (!mounted) return null

  const Nav = (
    <nav
      ref={navRef}
      aria-label="primary"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '12px',
        transform: 'translateX(-50%)',
        width: 'calc(100% - 24px)',
        maxWidth: 560,
        display: 'grid',
        gridTemplateColumns: 'repeat(5, 1fr)',
        gap: 8,
        padding: '6px 8px',
        borderRadius: 12,
        background: 'rgba(255,255,255,0.82)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
        zIndex: 1000,
        paddingBottom: 'max(6px, env(safe-area-inset-bottom))',
      }}
    >
      {items.map((it) => {
        const active = pathname === it.href || (it.href !== '/' && pathname?.startsWith(it.href))
        const disabled = !isLoggedIn && it.href !== '/'
        const base = counts[it.id] ?? 0
        const badge = it.id === 'talk' && debugBadge > 0 ? debugBadge : base
        const showBadge = badge > 0

        return (
          <a
            key={it.href}
            href={it.href}
            role="button"
            aria-current={active ? 'page' : undefined}
            aria-disabled={disabled || undefined}
            onClick={onClick(it)}
            style={{
              position: 'relative',
              display: 'grid',
              placeItems: 'center',
              gap: 2,
              textDecoration: 'none',
              borderRadius: 12,
              padding: '4px 2px',
              color: disabled ? '#999' : active ? '#4b5cff' : '#333',
              filter: disabled ? 'grayscale(0.2)' : undefined,
              transition: 'transform .12s ease, background .12s ease, color .12s ease',
            }}
          >
            <div style={{ fontSize: 15, lineHeight: 1, position: 'relative' }}>
              {it.icon}
              {showBadge && (
                <span
                  aria-label="unread count"
                  style={{
                    position: 'absolute',
                    top: -6,
                    right: -10,
                    minWidth: 18,
                    height: 18,
                    padding: '0 5px',
                    borderRadius: 999,
                    background: '#ff3b30',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 800,
                    lineHeight: '18px',
                    textAlign: 'center',
                    boxShadow: '0 2px 6px rgba(0,0,0,.18)',
                  }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 600 }}>{it.label}</div>
            {active && (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  bottom: 6,
                  width: 22,
                  height: 4,
                  background: 'currentColor',
                  borderRadius: 999,
                  opacity: 0.85,
                }}
              />
            )}
          </a>
        )
      })}
    </nav>
  )

  return host ? createPortal(Nav, host) : Nav
}
