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
        {/* ▼ クリック無効化ガード（data-guard-lock="1" を持つ要素配下の操作を捕捉して無効化） */}
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
    }, true); // capture段階で停止（Reactの水和前でも有効）
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
