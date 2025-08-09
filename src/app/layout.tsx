'use client'
import './globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
import Header from '../components/Header'
import { AuthProvider } from '@/context/AuthContext'
import { useState } from 'react'
import { usePathname } from 'next/navigation'

function LayoutBody({ children }: { children: React.ReactNode }) {
  const [showLogin, setShowLogin] = useState(false)
  const pathname = usePathname()

  // ルートごとの表示制御
  const isCredit = pathname?.startsWith('/credit') === true
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true // 将来の全幅ページもここで拾える

  return (
    <>
      {/* Mu系ページではヘッダー非表示 */}
      {!isMuAI && <Header onLoginClick={() => setShowLogin(true)} />}

      {/* 通常は 430px 中央寄せ。Mu系だけ全幅化 */}
      <main
        className={`mu-main ${isMuAI ? 'mu-main--wide' : ''}`}
        style={{ paddingBottom: isCredit ? 0 : 60 }}
      >
        {/* セクション安全ラッパ。Mu系は全幅 */}
        <div className={`mu-page ${isMuAI ? 'mu-page--wide' : ''}`}>
          {children}
        </div>
      </main>

      {/* クレジットだけはフッターを消す（iframeが全高を使うため） */}
      {!isCredit && <Footer />}
    </>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // window 直参照はやめてフックで判定（SSRでも安全）
  const pathname = usePathname()
  const isMuAI =
    pathname?.startsWith('/mu_ai') === true ||
    pathname?.startsWith('/mu_full') === true

  return (
    <html lang="ja">
      {/* bodyにもフラグクラスを付与してCSS側で切り替えやすく */}
      <body className={isMuAI ? 'mu-ai' : ''} style={{ margin: 0, background: '#fff' }}>
        <AuthProvider>
          <LayoutBody>{children}</LayoutBody>
        </AuthProvider>
      </body>
    </html>
  )
}
