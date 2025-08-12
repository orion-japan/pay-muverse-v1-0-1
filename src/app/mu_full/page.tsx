'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext' // Firebase認証用のContext
const FOOTER_H = 60

export default function MuFullPage() {
  const { user, loading } = useAuth()
  const [url, setUrl] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    const startMuAi = async () => {
      if (loading) return // Firebase認証状態の取得中
      if (!user) {
        setError('Firebase未ログインです')
        return
      }

      try {
        // ① Firebase IDトークン取得
        const idToken = await user.getIdToken(true)
        if (!idToken) {
          throw new Error('IDトークン取得失敗')
        }
        console.log('[mu_full] Firebase IDトークン取得OK')

        // ② MU 側セッション作成 (/api/call-mu-ai)
        const callRes = await fetch('/api/call-mu-ai', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })
        const callData = await callRes.json().catch(() => ({}))

        if (!callRes.ok || !callData?.sessionId) {
          throw new Error(callData?.error || 'MUセッション作成に失敗')
        }
        console.log('[mu_full] MUセッション作成OK:', callData)

        // ③ MU 側ログインURL取得 (/api/get-user-info)
        const infoRes = await fetch('/api/get-user-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: callData.sessionId,
            user_code: callData.user_code,
          }),
        })
        const infoData = await infoRes.json().catch(() => ({}))

        if (!infoRes.ok || !infoData?.login_url) {
          throw new Error(infoData?.error || 'MU側からログインURLが返りません')
        }
        console.log('[mu_full] MUログインURL取得OK:', infoData.login_url)

        // ④ iframeにURLをセット
        setUrl(infoData.login_url)
      } catch (err: any) {
        console.error('[mu_full] MUログイン処理失敗:', err)
        setError(err?.message || '不明なエラー')
      }
    }

    startMuAi()
  }, [user, loading])

  // エラー表示
  if (error) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
          color: 'red',
          fontWeight: 'bold',
        }}
      >
        エラー: {error}
      </div>
    )
  }

  // ローディング表示
  if (!url) {
    return (
      <div
        style={{
          height: `calc(100dvh - ${FOOTER_H}px)`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        Mu_AI を開始中…
      </div>
    )
  }

  // ログイン後（iframe表示）
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
    </div>
  )
}
