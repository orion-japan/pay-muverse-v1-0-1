// src/app/layout.tsx  ← 'use client' は付けない（Server Component）

import './globals.css'
import '../styles/layout.css'
import Providers from './providers'
import LayoutClient from './LayoutClient'
import TelemetryBoot from '@/components/TelemetryBoot'
import AuthExpose from './_auth-expose'

export const metadata = {
  manifest: '/manifest.json',
  themeColor: '#0b1437',
  icons: {
    icon: '/mira.png',
    shortcut: '/mira.png',
    apple: '/mira.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* VAPID をDOM/Windowへ供給 */}
        <meta name="vapid" content={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__VAPID_PUBLIC_KEY__=${JSON.stringify(
              process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || ''
            )};`,
          }}
        />
      </head>

      <body className="mu-body">
        <Providers>
          <LayoutClient>{children}</LayoutClient>
          <TelemetryBoot />
          <AuthExpose />
        </Providers>
      </body>
    </html>
  );
}
