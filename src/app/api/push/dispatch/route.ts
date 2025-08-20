// src/app/api/push/dispatch/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import webpush from 'web-push'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabase = createClient(url, serviceKey)

const VAPID_PUBLIC = process.env.VAPID_PUBLIC!
const VAPID_PRIVATE = process.env.VAPID_PRIVATE!
webpush.setVapidDetails('mailto:no-reply@example.com', VAPID_PUBLIC, VAPID_PRIVATE)

/**
 * 仕様:
 *  POST: { userCodes?: string[], payload: { title, body, url?, icon? } }
 *   - userCodes 未指定なら、user_settings.push_enabled=true の全員（大量配信は注意）
 *   - 実送信は push_subscriptions.enabled=true かつ user_settings.push_enabled=true の組だけ
 *  返却: { ok, sent, failed }
 */

type PushPayload = {
  title: string
  body: string
  url?: string
  icon?: string
  badge?: string
  tag?: string
  data?: Record<string, any>
}

export async function POST(req: Request) {
  try {
    const { userCodes, payload } = (await req.json()) as { userCodes?: string[]; payload?: PushPayload }

    if (!payload?.title || !payload?.body) {
      return NextResponse.json({ ok: false, message: 'payload.title and payload.body are required' }, { status: 400 })
    }

    // 送信対象ユーザーの決定
    let targets: string[] = []
    if (Array.isArray(userCodes) && userCodes.length) {
      targets = userCodes
    } else {
      // 全体送信（push_enabled のみ）
      const { data, error } = await supabase.from('user_settings').select('user_code').eq('push_enabled', true)
      if (error) throw error
      targets = (data || []).map((r) => r.user_code)
    }

    if (!targets.length) {
      return NextResponse.json({ ok: true, sent: 0, failed: 0 })
    }

    // サブスクリプション取得（ユーザー設定とサブスクの両方で ON のものだけ）
    const { data: subs, error: subErr } = await supabase
      .from('push_subscriptions')
      .select('user_code, endpoint, p256dh, auth, enabled')
      .in('user_code', targets)
      .eq('enabled', true)

    if (subErr) throw subErr

    // user_settings も確認（push_enabled=false のユーザーは弾く）
    const { data: settings, error: setErr } = await supabase
      .from('user_settings')
      .select('user_code, push_enabled')
      .in('user_code', targets)
    if (setErr) throw setErr
    const allowSet = new Set(settings?.filter((s) => s.push_enabled !== false).map((s) => s.user_code) || [])

    const list = (subs || []).filter((s) => allowSet.has(s.user_code))

    let sent = 0
    let failed = 0

    // 送信
    await Promise.all(
      list.map(async (s) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: s.endpoint,
              keys: { p256dh: s.p256dh, auth: s.auth },
            } as any,
            JSON.stringify(payload)
          )
          sent++
        } catch (e: any) {
          failed++
          console.warn('webpush failed:', e?.statusCode, e?.body)
          // 410/404 などは登録を削除
          if (e?.statusCode === 410 || e?.statusCode === 404) {
            await supabase.from('push_subscriptions').delete().eq('user_code', s.user_code).eq('endpoint', s.endpoint)
          }
        }
      })
    )

    return NextResponse.json({ ok: true, sent, failed })
  } catch (e: any) {
    console.error('/api/push/dispatch POST', e)
    return NextResponse.json({ ok: false, message: e?.message ?? 'Server error' }, { status: 500 })
  }
}
