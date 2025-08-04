'use client'
import Link from 'next/link'

export default function Header({ onLoginClick }) {
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
      {/* 左端 ホーム */}
      <Link href="/" style={{ textDecoration: 'none', color: 'white', fontSize: '18px' }}>
        🏠 Home
      </Link>

      {/* 中央タイトル */}
      <div style={{ fontSize: '22px', fontWeight: 'bold', textAlign: 'center', flex: 1 }}>
        Muverse
      </div>

      {/* 右端 ログインボタン */}
      <div>
        <button
          onClick={onLoginClick} // ✅ alertを削除してpropsを呼ぶ
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
      </div>
    </header>
  )
}
