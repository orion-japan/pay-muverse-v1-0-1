'use client'
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
      {/* ✅ Link を使用してページ遷移 */}
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
