// src/app/layout.tsx  ← 'use client' は付けない（Server Component）

import './globals.css'
import '../styles/layout.css'
import Providers from './providers'
import LayoutClient from './LayoutClient'   // ← 大文字小文字を実ファイル名に合わせる

export const metadata = {
  manifest: '/manifest.json',
  themeColor: '#0b1437',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body style={{ margin: 0 }}>
        <Providers>
          {/* LayoutClient は Client Component 側。ここに PushRegister を組み込む */}
          <LayoutClient>{children}</LayoutClient>
        </Providers>
      </body>
    </html>
  )
}
