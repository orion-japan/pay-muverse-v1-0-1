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

// --- helpers ---------------------------------------------------------------

/** エラーメッセージ文字列から「列が存在しない」かを推定 */
const isMissingColumn = (msg?: string) =>
  !!msg && /column ["']?enabled["']? does not exist|could not find the ["']enabled["'] column/i.test(msg)

/** user_settings.push_enabled を見て有効/無効を決める（無ければ true を返す） */
async function resolveEffectiveEnabled(userCode: string, requested?: boolean) {
  // 指定が無ければ true を初期値
  let effective = typeof requested === 'boolean' ? requested : true
  try {
    const { data, error } = await supabase
      .from('user_settings')
      .select('push_enabled')
      .eq('user_code', userCode)
      .maybeSingle()

    // テーブル自体が無い / 列が無い場合などは参照をスキップ
    if (!error && data && data.push_enabled === false) {
      effective = false
    }
  } catch {
    /* ignore */
  }
  return effective
}

/** push_subscriptions に upsert（enabled 列が無い環境では自動で enabled を外して再試行） */
async function upsertSubscription(
  userCode: string,
  sub: WebPushSubscription,
  enabled: boolean
) {
  // まずは enabled 付きで試す
  let { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_code: userCode,
      endpoint: sub.endpoint,
      p256dh: sub.keys!.p256dh,
      auth: sub.keys!.auth,
      // 環境によっては enabled 列が無い場合がある
      enabled,
    } as any,
    { onConflict: 'user_code,endpoint' }
  )

  // enabled 列が無いなら、enabled を外してリトライ
  if (error && isMissingColumn(error.message)) {
    const retry = await supabase.from('push_subscriptions').upsert(
      {
        user_code: userCode,
        endpoint: sub.endpoint,
        p256dh: sub.keys!.p256dh,
        auth: sub.keys!.auth,
      },
      { onConflict: 'user_code,endpoint' }
    )
    error = retry.error ?? null
    if (retry.error) return { error: retry.error, usedEnabled: false as const }
    return { error: null, usedEnabled: false as const }
  }

  return { error: error ?? null, usedEnabled: true as const }
}

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

    const effectiveEnabled = await resolveEffectiveEnabled(userCode, enabled)
    const { error, usedEnabled } = await upsertSubscription(userCode, subscription, effectiveEnabled)

    if (error) throw error

    return NextResponse.json({ ok: true, note: usedEnabled ? undefined : 'enabled column not found; saved without it' })
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

    // user_settings があれば尊重、無ければ requested をそのまま
    const finalEnabled = await resolveEffectiveEnabled(userCode, enabled)

    const qb = supabase.from('push_subscriptions').update({ enabled: finalEnabled } as any).eq('user_code', userCode)
    if (endpoint) qb.eq('endpoint', endpoint)
    let { error } = await qb

    // enabled 列が無い環境なら「変更できないがOK」を返す
    if (error && isMissingColumn(error.message)) {
      return NextResponse.json({ ok: true, note: 'enabled column not found; nothing updated' })
    }
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
