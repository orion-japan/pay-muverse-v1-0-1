'use client'
import { useAuth } from '@/context/AuthContext'

export default function MuFullPage() {
  const { userCode, loading } = useAuth()

  if (loading) {
    return (
      <div className="mu-page mu-page--wide" style={{ height: 'calc(100dvh - 60px)', display:'grid', placeItems:'center' }}>
        読み込み中…
      </div>
    )
  }

  if (!userCode) {
    return (
      <div className="mu-page mu-page--wide" style={{ height: 'calc(100dvh - 60px)', display:'grid', placeItems:'center' }}>
        🔒 ログインが必要です
      </div>
    )
  }

  const url = `https://mu-ui-v1-0-5.vercel.app/?user=${encodeURIComponent(userCode)}`

  return (
    // フッターが60px固定なので残りをまるごとiframeに
    <div className="mu-page mu-page--wide" style={{ height: 'calc(100dvh - 60px)' }}>
      <iframe
        src={url}
        style={{ width: '100%', height: '100%', border: 'none', display: 'block' }}
      />
    </div>
  )
}
