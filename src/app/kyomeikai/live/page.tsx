'use client'

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '@/context/AuthContext'

declare global {
  interface Window {
    JitsiMeetExternalAPI?: any
  }
}

export default function LivePage() {
  const { user, userCode } = useAuth()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<any>(null)

  // ★ 追加：配信ステータス保持
  const [isLive, setIsLive] = useState<boolean | null>(null)
  const [roomFromStatus, setRoomFromStatus] = useState<string | undefined>(undefined)

  useEffect(() => {
    let mounted = true

    // 外部APIスクリプトを読み込み
    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (window.JitsiMeetExternalAPI) return resolve()
        const s = document.createElement('script')
        s.src = 'https://meet.jit.si/external_api.js'
        s.async = true
        s.onload = () => resolve()
        s.onerror = (e) => reject(e)
        document.body.appendChild(s)
      })

    ;(async () => {
      try {
        // ★ まず配信状況を確認
        const r = await fetch('/api/kyomeikai/live/status', { cache: 'no-store' })
        const j = await r.json().catch(() => null)
        if (!mounted) return
        const live = !!j?.is_live
        setIsLive(live)
        setRoomFromStatus(j?.room)

        // 配信中でなければここで終了（Jitsiは起動しない）
        if (!live) return

        // 以下、配信中のみ実行
        await loadScript()
        if (!mounted || !containerRef.current || !window.JitsiMeetExternalAPI) return

        // ルーム名：status.room を優先、無ければ日付固定
        const today = new Date().toISOString().split('T')[0]
        const roomName = (j?.room && String(j.room)) || `kyomeikai-live-${today}`

        // 既存インスタンスがあれば破棄
        if (apiRef.current) {
          try { apiRef.current.dispose() } catch {}
          apiRef.current = null
        }

        // IFrame API で埋め込み（プリジョイン無効 / アプリ誘導無効）
        apiRef.current = new window.JitsiMeetExternalAPI('meet.jit.si', {
          parentNode: containerRef.current,
          roomName,
          width: '100%',
          height: '100%',
          userInfo: {
            // 匿名でもOK。あれば表示名に。
            displayName: user?.displayName || userCode || 'Guest',
          },
          configOverwrite: {
            prejoinConfig: { enabled: false }, // ← プリジョイン画面を消す
            disableDeepLinking: true,          // ← アプリ誘導を消す
            mobileAppPromo: false,
            startWithAudioMuted: true,
            startWithVideoMuted: true,
          },
          interfaceConfigOverwrite: {
            MOBILE_APP_PROMO: false,
            TOOLBAR_BUTTONS: [
              'microphone','camera','desktop','tileview','chat','raisehand','settings','hangup'
            ],
          },
        })

        // 画面遷移時の掃除
        apiRef.current.on('readyToClose', () => {
          try { apiRef.current?.dispose() } catch {}
          apiRef.current = null
        })
      } catch (e) {
        console.error('Jitsi init failed:', e)
        setIsLive(false)
      }
    })()

    return () => {
      mounted = false
      try { apiRef.current?.dispose() } catch {}
      apiRef.current = null
    }
  }, [user, userCode])

  return (
    <div className="mu-page mu-main">
      <header className="km-header" style={{padding:'12px 16px'}}>
        <h1 className="km-title" style={{fontSize: '18px'}}>共鳴会 LIVE</h1>
      </header>

      {/* 埋め込み領域（高さは画面に合わせて調整） */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 'calc(100vh - 72px)', // ヘッダ分を差し引き
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff'
        }}
      >
        {/* ★ 配信していない場合のメッセージ */}
        {isLive === false && (
          <div style={{textAlign:'center', padding:'12px', opacity:.9}}>
            <div style={{fontSize: '16px', marginBottom: '6px'}}>現在LIVE配信は行われていません。</div>
            {roomFromStatus ? <div>次回ルーム: {roomFromStatus}</div> : null}
          </div>
        )}
        {isLive === null && (
          <div style={{opacity:.8}}>配信状況を確認中…</div>
        )}
        {/* isLive === true のときは Jitsi がこの領域に埋まります */}
      </div>
    </div>
  )
}
