// src/app/mu_ai/page.tsx
'use client'
import { useAuth } from '@/context/AuthContext'
import { useEffect, useState } from 'react'

const FOOTER_H = 60

export default function MuAiPage() {
  const { userCode, loading } = useAuth()
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!loading && userCode) {
      // 埋め込み用パラメータを付けておく（必要なら）
      setUrl(`https://mu-ui-v1-0-5.vercel.app/?user=${encodeURIComponent(userCode)}&embed=1`)
    }
  }, [loading, userCode])

  if (loading) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100dvh', background:'#fff' }}>
        <p style={{ color:'#666', fontSize:16 }}>読み込み中...</p>
      </div>
    )
  }

  if (!userCode) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100dvh', background:'#fff' }}>
        <p style={{ color:'#666', fontSize:16 }}>🔒 ログインが必要です。</p>
      </div>
    )
  }

  return (
    <div style={{ width:'100%' }}>
      {url && (
        <iframe
          src={url}
          // 横いっぱい・フッター分だけ高さを引く
          style={{
            display: 'block',
            width: '100%',
            height: `calc(100dvh - ${FOOTER_H}px)`,
            border: 'none',
            background: 'transparent',
          }}
          // スクロール等を許可（必要に応じて調整）
          allow="clipboard-write; microphone *; camera *"
        />
      )}
    </div>
  )
}
