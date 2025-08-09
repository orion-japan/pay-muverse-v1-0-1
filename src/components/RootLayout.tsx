'use client'
import '../globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import Header from '../components/Header'
import { AuthProvider } from '@/context/AuthContext'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      {/* 背景は全体白。ここで中央寄せしない */}
      <body style={{ margin: 0, background: '#fff' }}>
        <AuthProvider>
          {/* ✅ スマホ幅固定（ここでだけ中央寄せ） */}
          <div
            style={{
              maxWidth: '430px',
              width: '100%',
              margin: '0 auto',
              background: '#f9fafb',
              minHeight: '100vh',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box'
            }}
          >
            {/* ✅ ヘッダー（ダミーで落ちないように修正） */}
            <Header onLoginClick={() => { /* no-op */ }} />

            {/* ✅ メイン：ヘッダー/フッター分の余白を確保 */}
            <div className="frame-container" style={{ flex: 1, width: '100%' }}>
              <main
                className="main-content"
                style={{
                  width: '100%',
                  paddingTop: 60,     // ヘッダー高
                  paddingBottom: 60,  // フッター高
                  boxSizing: 'border-box'
                }}
              >
                {children}
              </main>
            </div>

            {/* ✅ フッター（childrenは使わない） */}
            <Footer />
          </div>
        </AuthProvider>
      </body>
    </html>
  )
}
