'use client'
import Header from '../../components/Header'
import { useAuth } from '@/context/AuthContext'

export default function CreditPage() {
  const { userCode, loading } = useAuth()

  if (loading) return <div>読み込み中...</div>

  return (
    <div style={{ width: '100%', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* ✅ Header を上に固定 */}
      <Header onLoginClick={() => {}} />

      {/* ✅ iframe は Header 以外のスペース全部 */}
      <iframe
        src={`https://pay.muverse.jp/pay${userCode ? `?user=${userCode}` : ''}`}
        style={{
          width: '100%',
          height: 'calc(100vh - 110px)',  // ✅ Header(50px) + Footer(60px) を引く
          border: 'none',
          flex: 1
        }}
      />
    </div>
  )
}
