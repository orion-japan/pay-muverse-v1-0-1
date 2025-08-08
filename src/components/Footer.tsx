'use client'
import '../styles/globals.css'   // ✅ 修正
import '../styles/layout.css'
import Link from 'next/link'

export default function Footer() {
  return (
    <footer
      style={{
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        padding: '10px 0',
        background: '#fff',
        borderTop: '1px solid #eee',
        position: 'fixed',
        bottom: 0,
        width: '100%',
        height: '60px',
      }}
    >
      <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        Home
      </Link>
      <Link href="/chat" style={{ textDecoration: 'none', color: 'inherit' }}>
        Chat
      </Link>
      <Link href="/post" style={{ textDecoration: 'none', color: 'inherit' }}>
        投稿
      </Link>
      <Link href="/mypage" style={{ textDecoration: 'none', color: 'inherit' }}>
        My Page
      </Link>
    </footer>
  )
}
