'use client'
import './globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import { AuthProvider } from '@/context/AuthContext'

function LayoutBody({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        maxWidth: '430px',       // ✅ スマホ幅固定
        margin: '0 auto',        // ✅ 中央寄せ
        background: '#f9fafb',
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column'
      }}
    >
      <div className="frame-container" style={{ flex: 1 }}>
        <main className="main-content">
          {children}
        </main>
      </div>
      <Footer />
    </div>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ margin: 0, background: '#f9fafb' }}>
        <AuthProvider>
          <LayoutBody>{children}</LayoutBody>
        </AuthProvider>
      </body>
    </html>
  )
}
