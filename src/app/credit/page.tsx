// src/app/credit/page.tsx
'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/context/AuthContext'

export default function CreditRedirect() {
  const router = useRouter()
  const sp = useSearchParams()
  const { userCode } = useAuth()

  useEffect(() => {
    const qUser = sp.get('user')
    const user = qUser || userCode || ''
    // user があれば引き継ぐ（無ければ素の /pay）
    router.replace(`/pay${user ? `?user=${encodeURIComponent(user)}` : ''}`)
  }, [router, sp, userCode])

  return null
}
