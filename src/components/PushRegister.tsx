'use client'

import { useEffect } from 'react'
import { registerPush } from '@/utils/push'
import { useAuth } from '@/context/AuthContext'

export default function PushRegister() {
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

  return null // UI は不要
}
