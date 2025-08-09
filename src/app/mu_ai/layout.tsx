'use client'

export default function MuAiLayout({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* ヘッダーは描画しない */}
      <main style={{ flex: 1 }}>{children}</main>
    </div>
  )
}
