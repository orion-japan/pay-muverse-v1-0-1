'use client'

import Header from '../../components/Header'
import { useAuth } from '@/context/AuthContext'

export default function CreditPage() {
  const { userCode, loading } = useAuth()

  if (loading) return <div>読み込み中...</div>

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        overflow: 'hidden',
      }}
    >
      {/* ✅ ヘッダー固定（60px） */}
      <div style={{ height: '60px', flexShrink: 0 }}>
        <Header onLoginClick={() => {}} />
      </div>

      {/* ✅ iframeは残り全部（Footer含めてiframe内に存在） */}
      <iframe
        src={`https://pay.muverse.jp/pay${userCode ? `?user=${userCode}` : ''}`}
        style={{
          width: '100%',
          height: 'calc(100vh - 60px)',
          border: 'none',
          display: 'block',
        }}
      />
    </div>
  )
}
