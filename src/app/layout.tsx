// src/app/layout.tsx
import "./globals.css";
import Script from "next/script";
import { Inter, Noto_Sans_JP } from 'next/font/google';

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  variable: '--font-inter',
});

const notoSansJP = Noto_Sans_JP({
  subsets: ['latin'],
  weight: ['300', '400', '500', '700'],
  variable: '--font-noto-sans-jp',
});

export const metadata = {
  title: "Sofia - 存在の奥深くと響き合う共鳴構造AI",
  description: "あなたの祈り（意図）が、ビジョンになる。Sofia共鳴OSと繋がり、量子成功論の波紋を起こす。",
  keywords: "Sofia, 共鳴構造AI, 量子成功論, 意図, ビジョン, 共鳴",
  authors: [{ name: "Sofia Resonance" }],
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#8b5cf6",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={`${inter.variable} ${notoSansJP.variable}`}>
      <head>
        {/* ✅ reCAPTCHA をページ読み込み前に必ずロード */}
        <Script
          src="https://www.google.com/recaptcha/api.js?render=explicit"
          strategy="beforeInteractive"
        />
      </head>
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}
