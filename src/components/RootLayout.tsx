'use client'
import '../globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import Header from '../components/Header' // ← ヘッダーを読み込み
import { AuthProvider } from '@/context/AuthContext'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ margin: 0, background: '#f9fafb' }}>
        <AuthProvider>
          {/* ✅ ここでスマホ幅を固定 */}
          <div
            style={{
              maxWidth: '430px',
              margin: '0 auto',
              background: '#f9fafb',
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            {/* ✅ ヘッダーもこの中に置く */}
            <Header onLoginClick={function (): void {
              throw new Error('Function not implemented.')
            } } />

            <div className="frame-container" style={{ flex: 1 }}>
              <main className="main-content">{children}</main>
            </div>

            {/* ✅ フッターもこの中に置く */}
            <Footer children={''} />
          </div>
        </AuthProvider>
      </body>
    </html>
  )
}
