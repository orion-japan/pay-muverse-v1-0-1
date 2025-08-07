'use client'

export default function MuAiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'fixed',        // ← 画面全体に固定
        top: 0,
        left: 0,
        width: '100vw',           // ← ビューポート全体の幅
        height: '100vh',          // ← ビューポート全体の高さ
        margin: 0,
        padding: 0,
        overflow: 'hidden',       // ← スクロールなし
        backgroundColor: '#ffffff' // 必要に応じて背景色
      }}
    >
      {children}
    </div>
  )
}
