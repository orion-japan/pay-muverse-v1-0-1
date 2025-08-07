'use client'
// ❌ LoginModal 関連を削除
import { useState } from 'react'
import './globals.css'
import '../styles/layout.css'
import Footer from '../components/Footer'
// import LoginModal from '../components/LoginModal' ←削除
import { AuthProvider } from '@/context/AuthContext'

function LayoutBody({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="frame-container">
        <main className="main-content">{children}</main>
      </div>
      <Footer />
    </div>
  )
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AuthProvider>
          <LayoutBody>{children}</LayoutBody>
        </AuthProvider>
      </body>
    </html>
  )
}
