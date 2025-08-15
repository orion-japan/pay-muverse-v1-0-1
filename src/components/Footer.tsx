'use client'
import Link from 'next/link'

export default function Footer() {
  return (
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
        zIndex: 50,
      }}
    >
      <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>Home</Link>
      <Link href="/chat" style={{ textDecoration: 'none', color: 'inherit' }}>Mu Talk</Link>
      <Link href="/board" style={{ textDecoration: 'none', color: 'inherit' }}>ℚ Board</Link>
      <Link href="/mypage" style={{ textDecoration: 'none', color: 'inherit' }}>My Page</Link>
    </footer>
  )
}
