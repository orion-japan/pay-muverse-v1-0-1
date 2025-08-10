import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''

// 別名で設定していても拾えるようにフォールバック
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || // ← よくある別名
  ''

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('ENV CHECK supabaseServer.ts:', {
    url: !!SUPABASE_URL,
    sr: !!SERVICE_ROLE,
    srLen:
      (process.env.SUPABASE_SERVICE_ROLE ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        '').length,
  })
  throw new Error('Supabase env is missing (URL or SERVICE_ROLE)')
}

export const supabaseServer = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
})

