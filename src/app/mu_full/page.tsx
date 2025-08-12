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

        // === MU側APIに直接POST ===
        console.log('[mu_full] 📡 MU側 /api/get-user-info 呼び出し開始')
        const infoRes = await fetch('https://m.muverse.jp/api/get-user-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        })

        console.log('[mu_full] 📥 MU側 /api/get-user-info ステータス:', infoRes.status)
        const rawText = await infoRes.text()
        console.log('[mu_full] 📥 MU側 /api/get-user-info レスポンス本文(生):', rawText)

        let infoData: any = {}
        try {
          infoData = JSON.parse(rawText)
        } catch {
          console.warn('[mu_full] ⚠️ MU側 /api/get-user-info JSONパース失敗 → 生データ使用')
        }

        if (!infoRes.ok || !infoData?.login_url) {
          console.error('[mu_full] ❌ MU側からログインURLが返らない', infoData)
          throw new Error(infoData?.error || 'MU側からログインURLが返りません')
        }

        console.log('[mu_full] ✅ MUログインURL取得OK:', infoData.login_url)
        setUrl(infoData.login_url)
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
