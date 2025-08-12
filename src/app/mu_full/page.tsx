'use client'

import { useAuth } from '@/context/AuthContext'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'

const FOOTER_H = 60

export default function MuFullPage() {
  const { user, loading } = useAuth()
  const params = useSearchParams()
  const [url, setUrl] = useState<string>('')

  // DashboardPage から渡されたクエリ値
  const passedIdToken = params.get('idToken')
  const passedUserCode = params.get('user_code')

  useEffect(() => {
    console.log('[mu_full] loading:', loading, 'user:', user?.uid)
  }, [loading, user])

  // 初期マウント時に自動で MU 側にアクセス
  useEffect(() => {
    const startMuAi = async () => {
      if (!passedIdToken || !passedUserCode) {
        console.warn('[mu_full] クエリにidTokenまたはuser_codeがありません')
        return
      }

      try {
        // MU 側 API をサーバー経由で呼び出す
        const res = await fetch('/api/mu-get-user-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken: passedIdToken }),
        })

        const data = await res.json().catch(() => ({}))
        console.log('[mu_full] MU応答:', data)

        if (!res.ok || !data?.login_url) {
          throw new Error(data?.error || 'MU 側からURLが返りません')
        }

        setUrl(data.login_url)
      } catch (err) {
        console.error('[mu_full] Firebaseモード開始失敗:', err)
      }
    }

    startMuAi()
  }, [passedIdToken, passedUserCode])

  // ローディング中
  if (loading) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        読み込み中…
      </div>
    )
  }

  // 未ログイン時
  if (!user) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        🔒 ログインが必要です
      </div>
    )
  }

  // ログイン後
  return (
    <div
      style={{
        height: `calc(100dvh - ${FOOTER_H}px)`,
        margin: 0,
        padding: 0,
        display: 'grid',
        placeItems: 'center',
      }}
    >
      {!url ? (
        <div>Mu_AI を開始中…</div>
      ) : (
        <iframe
          src={url}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            display: 'block',
          }}
          allow="clipboard-write; microphone *; camera *"
        />
      )}
    </div>
  )
}
