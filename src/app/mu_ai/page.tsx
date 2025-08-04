'use client'
import { useAuth } from '@/context/AuthContext'

export default function MuAiPage() {
  const { userCode, loading } = useAuth()

  if (loading) return <div>読み込み中...</div>

  return (
    <div
      style={{
        position: 'fixed',     // ✅ これで画面に固定
        top: 0,                // ✅ 画面上端から
        left: 0,
        width: '100vw',
        height: 'calc(100vh - 50px)', // ✅ Footer分だけ引く
        margin: 0,
        padding: 0,
        background: 'white',   // ✅ 念のため背景も指定
        zIndex: 0              // ✅ 他要素の下敷きにならないように
      }}
    >
      <iframe
        src={`https://mu-ui-v1-0-5.vercel.app/${userCode ? `?user=${userCode}` : ''}`}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block'
        }}
      />
    </div>
  )
}
