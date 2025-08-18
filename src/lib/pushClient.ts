import { createClient } from '@supabase/supabase-js'

// Supabase クライアントの初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

// Push 通知に使う Payload 型
export type Payload = {
  title: string
  body: string
  url?: string
  id?: string   // ← ここを追加
}

// SW の登録と Push 通知送信
export async function registerAndSendPush(payload: Payload) {
  console.log('[push] START registerAndSendPush')

  // Service Worker の登録
  const reg = await navigator.serviceWorker.register('/sw.js')
  console.log('[push] SW registered:', !!reg)

  // Push購読情報を取得
  const sub = await reg.pushManager.getSubscription()
  if (!sub) {
    console.error('[push] No subscription found.')
    return { error: 'no-subscription' }
  }
  console.log('[push] has subscription?', !!sub)

  // Supabase Edge Function 呼び出し
  const { data, error } = await supabase.functions.invoke('sendPush', {
    body: {
      subscription: sub.toJSON(),
      payload,   // ← id を含んで送信できる
    },
  })

  console.log('[push] invoke result:', { data, error })
  return { data, error }
}
