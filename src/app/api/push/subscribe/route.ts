// src/app/api/push/subscribe/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

type WebPushSubscription = {
  endpoint: string
  expirationTime?: number | null
  keys?: { p256dh: string; auth: string }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(url, serviceKey)

/**
 * 仕様:
 *  POST  : { userCode, subscription, enabled? } を保存/更新（ON/OFF同時設定可）
 *  PATCH : { userCode, enabled } だけで ON/OFF 切り替え（全エンドポイントに適用）
 *  DELETE: { userCode, endpoint? } 解除（endpoint 未指定なら該当ユーザーの全解除）
 *
 *  返却: { ok, message? }
 */

// 保存/更新
export async function POST(req: Request) {
  try {
    const { userCode, subscription, enabled } = (await req.json()) as {
      userCode?: string
      subscription?: WebPushSubscription
      enabled?: boolean
    }

    if (!userCode || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return NextResponse.json({ ok: false, message: 'Missing userCode or subscription' }, { status: 400 })
    }

    // user_settings に push_enabled が false の場合、個別 enabled 指定があっても無効化で保存
    let effectiveEnabled = enabled
    if (typeof effectiveEnabled !== 'boolean') {
      // 未指定なら true にしつつ、ユーザー設定が false なら false
      effectiveEnabled = true
    }
    {
      const { data } = await supabase
        .from('user_settings')
        .select('push_enabled')
        .eq('user_code', userCode)
        .maybeSingle()

      if (data && data.push_enabled === false) {
        effectiveEnabled = false
      }
    }

    // upsert (user_code, endpoint) 一意
    const { error } = await supabase.from('push_subscriptions').upsert(
      {
        user_code: userCode,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys!.p256dh,
        auth: subscription.keys!.auth,
        enabled: effectiveEnabled,
      },
      { onConflict: 'user_code,endpoint' }
    )

    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('/api/push/subscribe POST', e)
    return NextResponse.json({ ok: false, message: e?.message ?? 'Server error' }, { status: 500 })
  }
}

// ON/OFF 切替（ユーザー単位 or endpoint 単位）
export async function PATCH(req: Request) {
  try {
    const { userCode, enabled, endpoint } = (await req.json()) as {
      userCode?: string
      enabled?: boolean
      endpoint?: string
    }

    if (!userCode || typeof enabled !== 'boolean') {
      return NextResponse.json({ ok: false, message: 'userCode and enabled are required' }, { status: 400 })
    }

    // user_settings.push_enabled が false のときは強制的に false
    let finalEnabled = enabled
    {
      const { data } = await supabase
        .from('user_settings')
        .select('push_enabled')
        .eq('user_code', userCode)
        .maybeSingle()
      if (data && data.push_enabled === false) {
        finalEnabled = false
      }
    }

    const qb = supabase.from('push_subscriptions').update({ enabled: finalEnabled }).eq('user_code', userCode)
    if (endpoint) qb.eq('endpoint', endpoint)
    const { error } = await qb
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('/api/push/subscribe PATCH', e)
    return NextResponse.json({ ok: false, message: e?.message ?? 'Server error' }, { status: 500 })
  }
}

// 解除（ユーザー全解除 or endpoint 単位）
export async function DELETE(req: Request) {
  try {
    const { userCode, endpoint } = (await req.json()) as { userCode?: string; endpoint?: string }
    if (!userCode) {
      return NextResponse.json({ ok: false, message: 'userCode is required' }, { status: 400 })
    }
    const qb = supabase.from('push_subscriptions').delete().eq('user_code', userCode)
    if (endpoint) qb.eq('endpoint', endpoint)
    const { error } = await qb
    if (error) throw error

    return NextResponse.json({ ok: true })
  } catch (e: any) {
    console.error('/api/push/subscribe DELETE', e)
    return NextResponse.json({ ok: false, message: e?.message ?? 'Server error' }, { status: 500 })
  }
}
