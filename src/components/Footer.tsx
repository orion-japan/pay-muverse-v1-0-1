'use client'
import Link from 'next/link'

export default function Footer() {
  return (
    // これ自身を中央430pxで固定配置にする（外枠ラッパは不要）
    <footer
      className="app-footer"
      style={{
        position: 'fixed',
        left: '50%',
        transform: 'translateX(-50%)',
        bottom: 0,
        width: '100%',
        maxWidth: '430px',
        height: 60,
        display: 'flex',
        justifyContent: 'space-around',
        alignItems: 'center',
        background: '#fff',
        borderTop: '1px solid #eee',
        boxShadow: '0 -1px 3px rgba(0,0,0,0.05)',
        zIndex: 50, // 念のため
      }}
    >
      <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>Home</Link>
      <Link href="/chat" style={{ textDecoration: 'none', color: 'inherit' }}>Chat</Link>
      <Link href="/post" style={{ textDecoration: 'none', color: 'inherit' }}>投稿</Link>
      <Link href="/mypage" style={{ textDecoration: 'none', color: 'inherit' }}>My Page</Link>
    </footer>
  )
}
