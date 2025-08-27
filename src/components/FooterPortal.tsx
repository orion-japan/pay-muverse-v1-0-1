// src/components/FooterPortal.tsx
'use client'
import { useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'

const PORTAL_ID = 'mu-footer-root'

function ensureContainer() {
  let el = document.getElementById(PORTAL_ID) as HTMLDivElement | null
  if (!el) {
    el = document.createElement('div')
    el.id = PORTAL_ID
    document.body.appendChild(el)
  }
  return el
}

export default function FooterPortal({ children }: { children: React.ReactNode }) {
  const container = useMemo(
    () => (typeof document !== 'undefined' ? ensureContainer() : null),
    []
  )

  // アンマウント時、他に子が無ければ片付ける（開発の二重マウントでも増殖しない）
  useEffect(() => {
    return () => {
      const el = document.getElementById(PORTAL_ID)
      if (el && el.childElementCount === 0) el.remove()
    }
  }, [])

  if (!container) return null
  return createPortal(children, container)
}
