// src/utils/push.ts
import { supabase } from '@/lib/supabase'

export async function registerPush(userCode: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

  const reg = await navigator.serviceWorker.ready
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      ? urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      : undefined,
  })

  const endpoint = subscription.endpoint // 👈 追加

  // Supabase に保存
  const { data, error } = await supabase
    .from('subscriptions')
    .upsert(
      {
        user_code: userCode,
        subscription,
        endpoint, // 👈 新カラムに保存
      },
      { onConflict: 'endpoint' } // 👈 デバイスごとにユニーク
    )

  if (error) throw error
  return data
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}
