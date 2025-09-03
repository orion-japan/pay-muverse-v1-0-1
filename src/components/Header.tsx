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
    // 外枠：全幅・固定配置（背景はここで付与し、透けないように不透明）
    <header
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        width: '100%',
        display: 'flex',
        justifyContent: 'center',
        boxShadow: '0 2px 6px rgba(0,0,0,0.08)',
        background: 'linear-gradient(90deg, #b089f9 0%, #9a7ff9 100%)', // ← 不透明
      }}
    >
      {/* 内枠：左右に目一杯（両端に配置） */}
      <div
        style={{
          width: '100%',
          maxWidth: '100%',           // ← 430px 制限を解除して左右いっぱい
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between', // ← 両端
          padding: '6px 10px',
          height: '44px',
          fontWeight: 'bold',
          color: '#fff',
          // 背景は外枠に移したのでここでは付けない／透けない
          borderRadius: 0,
        }}
      >
        {/* 左端 */}
        <Link
          href="/"
          onClick={prevent}
          style={{
            textDecoration: 'none',
            color: '#6b5dff',                // 白背景に映える色
            fontSize: '14px',
            fontWeight: 800,
            padding: '6px 10px',
            borderRadius: 8,
            background: '#ffffff',           // ← 不透明（透け防止）
            lineHeight: 1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            boxShadow: '0 1px 0 rgba(0,0,0,.04)',
          }}
        >
          <span aria-hidden>🏠</span>
          <span>Home</span>
        </Link>

        {/* 中央タイトル */}
        <div
          style={{
            fontSize: '16px',
            fontWeight: 900,
            textAlign: 'center',
            letterSpacing: '.3px',
            lineHeight: 1,
            color: '#fff',
            userSelect: 'none',
          }}
        >
          Muverse
        </div>

        {/* 右端 */}
        <div>
          {isLoggedIn ? (
            <button
              onClick={handleLogout}
              style={{
                height: 28,
                padding: '0 12px',
                background: '#ffffff',        // ← 不透明（透け防止）
                border: 'none',
                borderRadius: 8,
                color: '#6b5dff',
                fontSize: 12,
                fontWeight: 800,
                cursor: 'pointer',
                lineHeight: 1,
                boxShadow: '0 1px 0 rgba(0,0,0,.04)',
              }}
            >
              ログアウト
            </button>
          ) : (
            <button
              onClick={onLoginClick}
              style={{
                height: 28,
                padding: '0 12px',
                background: '#ffffff',        // ← 不透明（透け防止）
                border: 'none',
                borderRadius: 8,
                color: '#6b5dff',
                fontSize: 12,
                fontWeight: 800,
                cursor: 'pointer',
                lineHeight: 1,
                boxShadow: '0 1px 0 rgba(0,0,0,.04)',
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
