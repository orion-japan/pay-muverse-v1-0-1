// src/components/Footer.tsx
'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname, useRouter } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'

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

export default function Footer() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(false)
  const navRef = useRef<HTMLElement | null>(null)
  const router = useRouter()
  const pathname = usePathname()
  const { user } = useAuth()
  const isLoggedIn = !!user

  // ★ ここを固定。まず見た目を出す（APIは後で）
  const [counts] = useState<Record<ItemId, number>>({
    home: 0,
    talk: 0,     // ← 未読5件を固定表示
    board: 0,
    pay: 0,
    mypage: 0,
  })

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    try {
      let el = document.getElementById('mu-footer-root') as HTMLDivElement | null
      if (!el) {
        el = document.createElement('div')
        el.id = 'mu-footer-root'
        document.body.appendChild(el)
      }
      setHost(el)
    } catch {
      setHost(null)
    }
  }, [])

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
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [host, mounted])

  const items: Item[] = useMemo(
    () => [
      { id: 'home', label: 'Home', href: '/', icon: <span>🏠</span> },
      { id: 'talk', label: 'Talk', href: '/talk', icon: <span>💬</span> },
      { id: 'board', label: 'I Board', href: '/board', icon: <span>🧩</span> },
      { id: 'pay', label: 'Plan', href: '/pay', icon: <span>💳</span> },
      { id: 'mypage', label: 'My Page', href: '/mypage', icon: <span>👤</span> },
    ],
    []
  )

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
        const badge = counts[it.id] ?? 0
        const showBadge = isLoggedIn && badge > 0

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
            <div style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.2 }}>{it.label}</div>
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
