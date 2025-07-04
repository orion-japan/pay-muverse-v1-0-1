// src/app/layout.tsx
import "./globals.css";
import Script from "next/script";

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
    <html lang="ja">
      <head>
        {/* Google Fonts */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Noto+Sans+JP:wght@300;400;500;700&display=swap"
          rel="stylesheet"
        />
        
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
