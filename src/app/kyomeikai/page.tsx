'use client'
import { useSearchParams } from 'next/navigation'

export default function KyomeikaiPage() {
  const searchParams = useSearchParams()
  const user = searchParams.get('user') || ''

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      <iframe
        src={`https://muverse.jp/kyomeikai?user=${user}`} 
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
        }}
      />
    </div>
  )
}
