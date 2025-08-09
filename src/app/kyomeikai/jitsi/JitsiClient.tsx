'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

declare global {
  interface Window { JitsiMeetExternalAPI?: any }
}

function loadJitsiExternalAPI(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.JitsiMeetExternalAPI) {
      resolve(); return
    }
    const existed = document.querySelector<HTMLScriptElement>('script[data-jitsi-ext]')
    if (existed) {
      existed.addEventListener('load', () => resolve())
      existed.addEventListener('error', () => reject(new Error('jitsi external_api load error')))
      return
    }
    const s = document.createElement('script')
    s.src = 'https://meet.jit.si/external_api.js'
    s.async = true
    s.defer = true
    s.dataset.jitsiExt = '1'
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error('jitsi external_api load error')))
    document.head.appendChild(s)
  })
}

function defaultRoomName() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `kyomeikai-${y}${m}${day}`
}

export default function JitsiClient() {
  const params = useSearchParams()
  const displayName = useMemo(() => params.get('name') || 'Guest', [params])

  const containerRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<any>(null)

  const [roomName, setRoomName] = useState<string>(defaultRoomName())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    ;(async () => {
      try {
        // 任意：スケジュールから日付で部屋名を決める
        try {
          const r = await fetch('/api/kyomeikai/next')
          if (r.ok) {
            const j = await r.json()
            if (j?.start_at) {
              const d = new Date(j.start_at)
              const y = d.getFullYear()
              const m = String(d.getMonth() + 1).padStart(2, '0')
              const day = String(d.getDate()).padStart(2, '0')
              setRoomName(`kyomeikai-${y}${m}${day}`)
            }
          }
        } catch {}

        await loadJitsiExternalAPI()
        if (disposed) return

        const api = new window.JitsiMeetExternalAPI!('meet.jit.si', {
          roomName,
          parentNode: containerRef.current!,
          width: '100%',
          height: '100%',
          configOverwrite: {
            prejoinPageEnabled: false,   // プリジョイン画面OFF
            disableDeepLinking: true,    // アプリ誘導OFF
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            defaultLanguage: 'ja',
          },
          interfaceConfigOverwrite: {
            MOBILE_APP_PROMO: false,
            SHOW_JITSI_WATERMARK: false,
          },
          userInfo: { displayName },
        })
        apiRef.current = api
      } catch (e: any) {
        if (!disposed) setError(e?.message ?? '会議の読み込みに失敗しました')
      }
    })()

    return () => {
      disposed = true
      try { apiRef.current?.dispose?.() } catch {}
    }
  }, [displayName, roomName])

  return (
    <div
      style={{
        width: '100%',
        height: '100dvh',
        background: '#000',
        position: 'relative',
        margin: 0,
        padding: 0,
      }}
    >
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            padding: 16,
            textAlign: 'center',
            lineHeight: 1.6,
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
