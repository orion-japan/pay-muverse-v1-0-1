'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'

function KyomeikaiContent() {
  const searchParams = useSearchParams()
  const user = searchParams.get('user') || ''

  return (
    <iframe
      src={`https://muverse.jp/kyomeikai?user=${user}`}
      style={{
        width: '100%',
        height: '100%',
        border: 'none',
      }}
    />
  )
}

export default function KyomeikaiPage() {
  return (
    <div style={{ width: '100%', height: '100vh' }}>
      {/* ✅ Suspense でラップ */}
      <Suspense fallback={<div>読み込み中...</div>}>
        <KyomeikaiContent />
      </Suspense>
    </div>
  )
}
