'use client'

import { useEffect, useState } from 'react'
import { getAuth } from 'firebase/auth'

// ✅ 各種コンポーネント
import ShipVisibilityBox from '@/components/Settings/ShipVisibilityBox'
import NotificationSettingsBox from '@/components/Settings/NotificationSettingsBox'
import PushHelpCard from '@/components/Settings/PushHelpCard'

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin'

export default function SettingsPage() {
  const [plan, setPlan] = useState<Plan>('free')

  useEffect(() => {
    let mounted = true
    const ac = new AbortController()

    ;(async () => {
      const auth = getAuth()
      const user = auth.currentUser
      if (!user) return
      const token = await user.getIdToken(true)

      const res = await fetch('/api/account-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: ac.signal,
      }).catch(() => null)

      if (!res?.ok) return
      const j = await res.json()
      const ct = j?.click_type as string | undefined
      if (!mounted) return
      setPlan(
        ct === 'regular' ? 'regular' :
        ct === 'premium' ? 'premium' :
        ct === 'master' ? 'master' :
        ct === 'admin' ? 'admin' : 'free'
      )
    })()

    return () => {
      mounted = false
      ac.abort()
    }
  }, [])

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <h2 style={{ marginBottom: 12 }}>設定</h2>

      {/* 🚢 シップ公開範囲 */}
      <div style={{ marginBottom: 24 }}>
        <ShipVisibilityBox planStatus={plan} />
      </div>

      {/* 🔔 通知設定 */}
      <div style={{ marginBottom: 24 }}>
      <NotificationSettingsBox planStatus={plan} />

      </div>

      {/* 📣 プッシュ通知ヘルプ */}
      <div style={{ marginBottom: 24 }}>
        <PushHelpCard />
      </div>
    </div>
  )
}
