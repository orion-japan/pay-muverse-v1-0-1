'use client'

import { useAuth } from '@/context/AuthContext'
import { useEffect, useState } from 'react'
import CryptoJS from 'crypto-js' // HMAC生成用（ブラウザ）

const FOOTER_H = 60
const MU_BASE = 'https://mu-ui-v1-0-5.vercel.app' // MU UI 本体
const SHARED_SECRET = process.env.NEXT_PUBLIC_SHARED_SECRET || ''

export default function MuFullPage() {
  const { userCode, loading } = useAuth()
  const [url, setUrl] = useState<string>('')

  // ログ出す（どの値で作るか見えるように）
  useEffect(() => {
    console.log('[mu_full] loading:', loading, 'userCode:', userCode)
  }, [loading, userCode])

  // ボタン押下でiframe用URLを構築
  const handleStart = () => {
    if (!userCode) return

    const ts = Date.now().toString()
    const sig = CryptoJS.HmacSHA256(`${userCode}:${ts}`, SHARED_SECRET)
      .toString(CryptoJS.enc.Hex)

    const next = encodeURIComponent('/')
    const built =
      `${MU_BASE}/auto-login` +
      `?user=${encodeURIComponent(userCode)}` +
      `&ts=${ts}` +
      `&sig=${sig}` +
      `&embed=1` +
      `&next=${next}`

    console.log('[mu_full] iframe URL を構築:', built)
    setUrl(built)
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
  if (!userCode) {
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
          style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
          allow="clipboard-write; microphone *; camera *"
        />
      )}
    </div>
  )
}
