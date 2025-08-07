'use client'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { useRouter } from 'next/navigation' // ✅ 追加

type Props = {
  onLoginClick: () => void
}

export default function Header({ onLoginClick }: Props) {
  const { user, loading, logout } = useAuth()
  const router = useRouter() // ✅ 追加

  const isLoggedIn = !!user && !loading

  const prevent = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isLoggedIn) {
      e.preventDefault()
      onLoginClick()
    }
  }

  const handleLogout = async () => {
    await logout()               // ✅ Firebaseログアウト & Context初期化
    router.push('/')             // ✅ userクエリを含まないトップページへ
  }

  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 16px',
        background: 'linear-gradient(90deg, #b089f9, #9a7ff9)',
        color: 'white',
        fontWeight: 'bold',
        height: '60px',
        boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
      }}
    >
      <Link
        href="/"
        onClick={prevent}
        style={{ textDecoration: 'none', color: 'white', fontSize: '18px' }}
      >
        🏠 Home
      </Link>

      <div style={{ fontSize: '22px', fontWeight: 'bold', textAlign: 'center', flex: 1 }}>
        Muverse
      </div>

      <div>
        {isLoggedIn ? (
          <button
            onClick={handleLogout} // ✅ 修正
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              color: 'white',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            ログアウト
          </button>
        ) : (
          <button
            onClick={onLoginClick}
            style={{
              background: 'rgba(255,255,255,0.2)',
              border: 'none',
              borderRadius: '6px',
              padding: '6px 12px',
              color: 'white',
              fontWeight: 'bold',
              cursor: 'pointer',
            }}
          >
            ログイン
          </button>
        )}
      </div>
    </header>
  )
}
