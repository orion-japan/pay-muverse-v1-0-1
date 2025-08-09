'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

/** Jitsi外部APIの型 */
declare global {
  interface Window {
    JitsiMeetExternalAPI?: any
  }
}

/** external_api.js を一度だけロード */
function loadJitsiExternalAPI(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.JitsiMeetExternalAPI) {
      resolve()
      return
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

/** デフォルトのルーム名（日付ベース） */
function defaultRoomName() {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `kyomeikai-${y}${m}${day}`
}

export default function KyomeikaiJitsiPage() {
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
        // （任意）次回スケジュールの開始日でルーム名を決める
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
        } catch { /* 失敗時はデフォルトのまま */ }

        await loadJitsiExternalAPI()
        if (disposed) return

        const domain = 'meet.jit.si'
        const options = {
          roomName,
          parentNode: containerRef.current!,
          width: '100%',
          height: '100%',

          // ここが“アプリ要らずで即ブラウザ入室”の肝
          configOverwrite: {
            prejoinPageEnabled: false,   // プリジョイン画面をスキップ
            disableDeepLinking: true,    // 「アプリで開く」誘導を抑止
            startWithAudioMuted: false,
            startWithVideoMuted: false,
            // iOS等で言語
            defaultLanguage: 'ja',
          },
          interfaceConfigOverwrite: {
            MOBILE_APP_PROMO: false,     // モバイルアプリの宣伝を非表示
            SHOW_JITSI_WATERMARK: false,
          },

          userInfo: { displayName },
        }

        const api = new window.JitsiMeetExternalAPI!(domain, options)
        apiRef.current = api

        // 参考：イベント
        api.addEventListener('videoConferenceJoined', () => {
          // console.log('joined')
        })
      } catch (e: any) {
        if (!disposed) setError(e?.message ?? '会議の読み込みに失敗しました')
      }
    })()

    return () => {
      disposed = true
      try {
        apiRef.current?.dispose?.()
      } catch {}
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
