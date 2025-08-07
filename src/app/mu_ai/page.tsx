'use client'
import { useAuth } from '@/context/AuthContext'
import { useEffect, useState } from 'react'

export default function MuAiPage() {
  const { userCode, loading } = useAuth()
  const [url, setUrl] = useState('')

  useEffect(() => {
    if (!loading && userCode) {
      setUrl(`https://mu-ui-v1-0-5.vercel.app/?user=${userCode}`)
    }
  }, [loading, userCode])

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen bg-white">
        <p className="text-gray-600 text-lg">読み込み中...</p>
      </div>
    )
  }

  if (!userCode) {
    return (
      <div className="flex justify-center items-center h-screen bg-white">
        <p className="text-gray-600 text-lg">🔒 ログインが必要です。</p>
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100vh' }}>
      {url && (
        <iframe
          src={url}
          style={{
            width: '100%',
            height: 'calc(100vh - 60px)', // ヘッダー分除外
            border: 'none',
          }}
        />
      )}
    </div>
  )
}
