'use client'
import { useEffect, useState } from 'react'
import './PlanStatusBadge.css'

type PlanStatus = 'free' | 'regular' | 'premium' | 'master' | 'admin'

type Props = {
  userCode?: string
}

export default function PlanStatusBadge({ userCode }: Props) {
  const [status, setStatus] = useState<PlanStatus>('free')
  const [until, setUntil] = useState<string | null>(null)

  useEffect(() => {
    if (!userCode) return
    ;(async () => {
      try {
        const res = await fetch(`/api/account-status?user=${encodeURIComponent(userCode)}`, { cache: 'no-store' })
        const j = await res.json()
        if (res.ok) {
          setStatus((j?.plan_status as PlanStatus) || 'free')
          setUntil(j?.plan_valid_until || null)
        }
      } catch {}
    })()
  }, [userCode])

  if (!userCode) return null
  if (status === 'admin') return null // ← 管理者は非表示

  const labelMap: Record<Exclude<PlanStatus, 'admin'>, string> = {
    free: 'Free',
    regular: 'Regular',
    premium: 'Premium',
    master: 'Master',
  }

  const label = labelMap[status as Exclude<PlanStatus, 'admin'>] || 'Free'

  return (
    <div className={`plan-badge plan-${status}`}>
      <span className="plan-dot" />
      <span className="plan-text">{label}</span>
      {until && <span className="plan-until"> / 有効: {new Date(until).toLocaleDateString()}</span>}
    </div>
  )
}
