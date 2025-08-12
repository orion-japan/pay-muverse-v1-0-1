'use client'

import { useAuth } from '@/context/AuthContext'
import { useEffect, useState } from 'react'

const FOOTER_H = 60
const MU_GET_INFO_API = 'https://muverse.jp/api/get-user-info' // MU 側API（Firebaseモード対応）

export default function MuFullPage() {
  const { user, loading } = useAuth()
  const [url, setUrl] = useState<string>('')

  useEffect(() => {
    console.log('[mu_full] loading:', loading, 'user:', user?.uid)
  }, [loading, user])

  // ボタン押下でiframe用URLを構築（Firebaseモード）
  const handleStart = async () => {
    if (!user) return

    try {
      // Firebase ID トークン取得
      const idToken = await user.getIdToken(true)

      // MU 側にFirebaseモードで送信
      const res = await fetch(MU_GET_INFO_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: '2025-08-11',
          request_id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
          auth: {
            mode: 'firebase',
            idToken: idToken,
          },
        }),
      })

      const data = await res.json().catch(() => ({}))
      console.log('[mu_full] MU応答:', data)

      if (!res.ok || !data?.login_url) {
        throw new Error(data?.error || 'MU 側からURLが返りません')
      }

      // MU 側から返されたログイン済みURLをiframeに設定
      setUrl(data.login_url)
    } catch (err) {
      console.error('[mu_full] Firebaseモード開始失敗:', err)
    }
  }

  // ローディング中
  if (loading) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        読み込み中…
      </div>
    )
  }

  // 未ログイン時
  if (!user) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        🔒 ログインが必要です
      </div>
    )
  }

  // ログイン後
  return (
    <div
      style={{
        height: `calc(100dvh - ${FOOTER_H}px)`,
        margin: 0,
        padding: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {!url ? (
        <button
          onClick={handleStart}
          style={{
            padding: '12px 24px',
            fontSize: '16px',
            borderRadius: '8px',
            background: '#4F46E5',
            color: '#fff',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Mu_AI を開始
        </button>
      ) : (
        <iframe
          src={url}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          allow="clipboard-write; microphone *; camera *"
        />
      )}
    </div>
  )
}
