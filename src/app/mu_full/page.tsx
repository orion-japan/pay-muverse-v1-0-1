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
      console.log('========== [mu_full] ページロード開始 ==========')
      console.log('[mu_full] Firebase認証状態:', { loading, hasUser: !!user })

      if (loading) {
        console.log('[mu_full] ⏳ Firebase認証状態取得中 → 待機')
        return
      }
      if (!user) {
        console.error('[mu_full] ❌ Firebase未ログイン → 処理中断')
        setError('Firebase未ログインです')
        return
      }

      try {
        console.log('[mu_full] 🔍 Firebase IDトークン取得開始')
        const idToken = await user.getIdToken(true)
        if (!idToken) {
          throw new Error('IDトークン取得失敗')
        }
        console.log('[mu_full] ✅ Firebase IDトークン取得OK（長さ）:', idToken.length)

        // === MU側API（send-token経由）にPOST ===
        console.log('[mu_full] 📡 MU側 /api/mu-ai/send-token 呼び出し開始')
        const infoRes = await fetch('/api/mu-ai/send-token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })

        console.log('[mu_full] 📥 MU側 /api/mu-ai/send-token ステータス:', infoRes.status)

        const infoData: any = await infoRes.json().catch(() => null)
        console.log('[mu_full] 📥 MU側 /api/mu-ai/send-token JSON:', infoData)

        const loginUrl = infoData?.callMuAi?.login_url
        if (!infoRes.ok || !loginUrl) {
          console.error('[mu_full] ❌ MU側からログインURLが返らない', infoData)
          throw new Error(infoData?.error || 'MU側からログインURLが返りません')
        }

        console.log('[mu_full] ✅ MUログインURL取得OK:', loginUrl)
        setUrl(loginUrl)
        console.log('[mu_full] 🎯 iframe URL セット完了')
      } catch (err: any) {
        console.error('[mu_full] ❌ MUログイン処理失敗:', err)
        setError(err?.message || '不明なエラー')
      } finally {
        console.log('========== [mu_full] ページロード処理終了 ==========')
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
