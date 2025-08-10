'use client'
import { useEffect, useRef } from 'react'

export default function LivePage() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Jitsi External APIの読み込み
    const script = document.createElement('script')
    script.src = 'https://meet.jit.si/external_api.js'
    script.async = true
    script.onload = () => {
      if (containerRef.current) {
        const domain = 'meet.jit.si'
        const options = {
          roomName: 'KyomeikaiLiveRoom', // ← ホストと同じルーム名にする
          width: '100%',
          height: 600,
          parentNode: containerRef.current,
          interfaceConfigOverwrite: {
            TOOLBAR_BUTTONS: [
              'microphone', 'camera', 'chat', 'fullscreen', 'hangup'
            ],
            SHOW_JITSI_WATERMARK: false,
            SHOW_BRAND_WATERMARK: false,
          },
          configOverwrite: {
            startWithAudioMuted: true,
            startWithVideoMuted: true,
            prejoinPageEnabled: false, // プリジョイン画面をスキップ
            disableInviteFunctions: true,
          },
          userInfo: {
            displayName: 'LIVE視聴者'
          }
        }
        // @ts-ignore
        const api = new JitsiMeetExternalAPI(domain, options)

        // 発言/カメラ無効化
        api.executeCommand('toggleAudio') // ミュート
        api.executeCommand('toggleVideo') // カメラOFF
      }
    }
    document.body.appendChild(script)
  }, [])

  return (
    <div style={{ padding: '20px' }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: '10px' }}>🌐 共鳴会 LIVE</h1>
      <div ref={containerRef} style={{ border: '1px solid #ccc', borderRadius: '8px' }} />
      <p style={{ marginTop: '10px', color: '#666' }}>
        ※ LIVEはブラウザで直接視聴できます（マイク・カメラは無効化されています）
      </p>
    </div>
  )
}
