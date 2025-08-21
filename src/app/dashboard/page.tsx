'use client'

import { useEffect } from 'react'
import { useAuth } from '@/context/AuthContext'
import { registerPush } from '@/utils/push'

export default function DashboardPage() {
  const { userCode } = useAuth()

  useEffect(() => {
    if (userCode) {
      registerPush(userCode).then((res) => {
        console.log("Push登録結果:", res)
      }).catch((err) => {
        console.error("❌ Push登録失敗:", err)
      })
    }
  }, [userCode])

  return (
    <div>
      <h1>📱 ダッシュボード</h1>
      <p>Push通知の登録状況は Console に出ます。</p>
    </div>
  )
}
