// src/app/layout.tsx  ← Server Component（'use client' なし）

import './globals.css';
import '../styles/layout.css';
import '../styles/iros-vars.css'; // ★ グローバル変数を全体に展開
import Providers from './providers';
import LayoutClient from './LayoutClient';
import TelemetryBoot from '@/components/TelemetryBoot';
import AuthExpose from './_auth-expose';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  manifest: '/manifest.json',
  icons: {
    icon: '/mira.png',
    shortcut: '/mira.png',
    apple: '/mira.png',
  },
};

// Next.js 15 推奨: themeColor は viewport へ
export const viewport: Viewport = {
  themeColor: '#0b1437',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <head>
        {/* VAPID を DOM/Window へ供給（ビルド時に文字列化） */}
        <meta name="vapid" content={process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY} />
        <script
          dangerouslySetInnerHTML={{
            __html: `window.__VAPID_PUBLIC_KEY__=${JSON.stringify(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? '')};`,
          }}
        />
        {/* ▼ クリック無効化ガード（data-guard-lock="1" 配下の操作を捕捉して無効化） */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  function withinLocked(el){
    while (el && el !== document){
      if (el.getAttribute && el.getAttribute('data-guard-lock') === '1') return true;
      el = el.parentElement;
    }
    return false;
  }
  var types = ['click','pointerdown','mousedown','touchstart','keydown'];
  for (var i=0;i<types.length;i++){
    document.addEventListener(types[i], function(e){
      if (e.type==='keydown' && e.key!=='Enter' && e.key!==' ') return;
      if (withinLocked(e.target)){
        e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      }
    }, true);
  }
})();`,
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
