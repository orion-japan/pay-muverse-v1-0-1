// src/app/layout.tsx  ← 'use client' は付けない（Server Component）

import './globals.css'
import '../styles/layout.css'
import Providers from './providers'
import LayoutClient from './LayoutClient'   // ← 実ファイル名に合わせて
import TelemetryBoot from '@/components/TelemetryBoot' // ★ クライアント常駐ロガー
import AuthExpose from './_auth-expose'     // ★ 追加：Firebaseトークンをwindowへ公開

export const metadata = {
  manifest: '/manifest.json',
  themeColor: '#0b1437',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* VAPID をDOM/Windowへ供給 */}
        <meta name="vapid" content={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__VAPID_PUBLIC_KEY__=${JSON.stringify(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '')};`,
          }}
        />
      </head>
      <body className="mu-body">
        <Providers>
          {/* LayoutClient 内で main/footer を構成 */}
          <LayoutClient>{children}</LayoutClient>

          {/* 全ページでページ遷移/online/offline/Auth落ちを記録 */}
          <TelemetryBoot />

          {/* ★ 追加：ログイン状態を拾って ID_TOKEN を取れるように公開 */}
          <AuthExpose />
        </Providers>
      </body>
    </html>
  )
}
