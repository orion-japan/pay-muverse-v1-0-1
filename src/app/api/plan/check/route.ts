// app/api/plan/check/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY! // サーバー専用キー

export async function POST(req: Request) {
  try {
    const { user } = await req.json()
    if (!user) {
      return NextResponse.json({ error: 'user required' }, { status: 400 })
    }

    const supabase = createClient(url, serviceKey)

    // ▼ 例：subscriptions テーブルから最新の購読を取得
    // 例のカラム：user_code, plan_type('free'|'basic'|'pro'等), status('active'|'trialing'|'canceled'等), created_at
    const { data, error } = await supabase
      .from('subscriptions')
      .select('plan_type,status')
      .eq('user_code', user)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      // レコードなしや一時的エラーは free とみなす
      return NextResponse.json({ plan: 'free', active: false })
    }

    if (!data) {
      return NextResponse.json({ plan: 'free', active: false })
    }

    const active = data.status === 'active' || data.status === 'trialing'
    const plan = active ? data.plan_type : 'free'

    return NextResponse.json({ plan, active })
  } catch (e: any) {
    return NextResponse.json({ plan: 'free', active: false, error: e?.message ?? 'unknown' })
  }
}
