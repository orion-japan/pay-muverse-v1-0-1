'use client'
import Link from 'next/link'
import { useAuth } from '@/context/AuthContext'
import { useRouter } from 'next/navigation'

type Props = { onLoginClick: () => void }

export default function Header({ onLoginClick }: Props) {
  const { user, loading, logout } = useAuth()
  const router = useRouter()
  const isLoggedIn = !!user && !loading

  const prevent = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!isLoggedIn) {
      e.preventDefault()
      onLoginClick()
    }
  }

  const handleLogout = async () => {
    await logout()
    router.push('/')
  }

  return (
    // 外枠：全幅・中央寄せ（背景は付けない）
    <header
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        boxShadow: '0 2px 6px rgba(0,0,0,0.1)',
      }}
    >
      {/* 内枠：中央430pxに背景グラデを適用 */}
      <div
        style={{
          width: '100%',
          maxWidth: '430px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          height: '60px',
          fontWeight: 'bold',
          color: 'white',
          background: 'linear-gradient(90deg, #b089f9, #9a7ff9)',
        }}
      >
        <Link
          href="/"
          onClick={prevent}
          style={{ textDecoration: 'none', color: 'white', fontSize: '18px' }}
        >
          🏠 Home
        </Link>

        <div style={{ fontSize: '22px', fontWeight: 'bold', textAlign: 'center' }}>
          Muverse
        </div>

        <div>
          {isLoggedIn ? (
            <button
              onClick={handleLogout}
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
      </div>
    </header>
  )
}
