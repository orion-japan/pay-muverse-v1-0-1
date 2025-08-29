import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabaseAdmin'
import { mapClickToPlan } from '@/lib/planMap'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const { user_code, new_click_type, reason = 'plan.apply', source = 'system', plan_valid_until, payjp_subscription_id } =
      await req.json()

    if (!user_code || !new_click_type) {
      return NextResponse.json({ error: 'user_code and new_click_type required' }, { status: 400 })
    }

    // 現状取得
    const { data: u, error: e1 } = await supabaseAdmin
      .from('users')
      .select('click_type, plan_status')
      .eq('user_code', user_code)
      .maybeSingle()
    if (e1) throw e1

    const old_click = u?.click_type ?? null
    const new_plan = mapClickToPlan(new_click_type)
    const old_plan = u?.plan_status ?? null

    // users 更新
    const { error: e2 } = await supabaseAdmin
      .from('users')
      .update({
        click_type: new_click_type,
        plan_status: new_plan,
        ...(plan_valid_until ? { plan_valid_until } : {}),
        ...(payjp_subscription_id ? { payjp_subscription_id } : {})
      })
      .eq('user_code', user_code)
    if (e2) throw e2

    // 直前オープン履歴を締める
    const { data: openHist } = await supabaseAdmin
      .from('plan_history')
      .select('id')
      .eq('user_code', user_code)
      .is('ended_at', null)
      .order('started_at', { ascending: false })
      .limit(1)

    if (openHist && openHist[0]) {
      await supabaseAdmin.from('plan_history').update({ ended_at: new Date().toISOString() }).eq('id', openHist[0].id)
    }

    // 新しい履歴開始
    const { error: e3 } = await supabaseAdmin.from('plan_history').insert({
      user_code,
      from_click_type: old_click,
      to_click_type: new_click_type,
      from_plan_status: old_plan,
      to_plan_status: new_plan,
      reason,
      source,
      started_at: new Date().toISOString()
    } as any)
    if (e3) throw e3

    return NextResponse.json({ ok: true, plan_status: new_plan })
  } catch (e: any) {
    console.error('[plan/apply] error', e)
    return NextResponse.json({ error: e?.message || 'error' }, { status: 500 })
  }
}
