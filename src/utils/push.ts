import { supabase } from '@/lib/supabase'

export async function registerPush(userCode: string) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return

  // Service Worker 登録済みを待つ
  const reg = await navigator.serviceWorker.ready

  // Push Subscription を取得
  const subscription = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
      ? urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY)
      : undefined,
  })

  // 👇 endpoint を取り出す
  const endpoint = subscription.endpoint

  // Supabase に保存（endpoint ユニーク制約で upsert）
  const { data, error } = await supabase
    .from('subscriptions')
    .upsert(
      {
        user_code: userCode,
        subscription,
        endpoint, // 👈 新カラムに保存
      },
      { onConflict: 'endpoint' } // 同じデバイスなら上書き
    )
    .select() // 👈 保存結果を返す

  if (error) {
    console.error('❌ registerPush failed:', error)
    throw error
  }

  console.log('✅ Push subscription registered:', data)
  return data
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = atob(base64)
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)))
}
