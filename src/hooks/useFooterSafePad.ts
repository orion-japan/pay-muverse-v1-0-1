// src/hooks/useFooterSafePad.ts
'use client'

import { useEffect } from 'react'

/** Portal 先の <footer>/#mu-footer-root を監視して --footer-safe-pad を更新 */
export function useFooterSafePad(enabled = true) {
  useEffect(() => {
    if (!enabled) {
      document.documentElement.style.setProperty('--footer-h', '0px')
      document.documentElement.style.setProperty('--footer-safe-pad', '0px')
      return
    }

    const host =
      (document.getElementById('mu-footer-root') as HTMLElement | null) ??
      (document.querySelector('footer') as HTMLElement | null)

    const setPad = (h: number) => {
      const px = Math.max(0, Math.round(h || 0))
      document.documentElement.style.setProperty('--footer-h', `${px}px`)
      document.documentElement.style.setProperty(
        '--footer-safe-pad',
        `calc(${px}px + env(safe-area-inset-bottom))`
      )
    }

    // フォールバック（初期値）
    setPad(56)

    const update = () => {
      const el =
        (document.querySelector('#mu-footer-root nav, #mu-footer-root footer') as HTMLElement | null) ??
        (document.querySelector('footer') as HTMLElement | null)
      setPad(el?.getBoundingClientRect().height || 56)
    }

    update()

    const ro = 'ResizeObserver' in window ? new ResizeObserver(update) : null
    if (ro && host) ro.observe(host)

    window.addEventListener('resize', update)
    document.fonts?.addEventListener?.('loadingdone', update)

    const iv = window.setInterval(update, 1000) // 最後の保険

    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', update)
      document.fonts?.removeEventListener?.('loadingdone', update)
      window.clearInterval(iv)
      document.documentElement.style.removeProperty('--footer-h')
      document.documentElement.style.removeProperty('--footer-safe-pad')
    }
  }, [enabled])
}
