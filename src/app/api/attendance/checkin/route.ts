import { NextRequest, NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabaseServer'
import { adminAuth } from '@/lib/firebase-admin'  // 既存のFirebase Admin
import { DateTime } from 'luxon'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/attendance/checkin
 * body: { idToken: string, event_id: 'kyomeikai' | 'ainori' }
 * 成功時: { ok:true, zoom_url }
 */
export async function POST(req: NextRequest) {
  try {
    const { idToken, event_id } = await req.json()

    if (!idToken || !event_id) {
      return NextResponse.json({ ok: false, error: 'BAD_REQUEST' }, { status: 400 })
    }

    // 認証 → uid
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    const firebase_uid = decoded.uid

    // uid → user_code
    const { data: userRow, error: userErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    if (userErr || !userRow?.user_code) {
      return NextResponse.json({ ok: false, error: 'USER_NOT_FOUND' }, { status: 403 })
    }
    const user_code = userRow.user_code

    // イベント設定取得
    const { data: ev, error: evErr } = await supabaseServer
      .from('event_master')
      .select('event_id, name, zoom_url, daily_start_hhmm, timezone, active')
      .eq('event_id', event_id)
      .maybeSingle()

    if (evErr || !ev?.active) {
      return NextResponse.json({ ok: false, error: 'EVENT_NOT_ACTIVE' }, { status: 404 })
    }

    const tz = ev.timezone || 'Asia/Tokyo'
    const [hh, mm] = (ev.daily_start_hhmm || '00:00').split(':').map(n => parseInt(n, 10))

    // 今日の開始時刻（タイムゾーン基準）
    const now = DateTime.now().setZone(tz)
    const start = now.set({ hour: hh, minute: mm, second: 0, millisecond: 0 })
    // ±10分ウィンドウ
    const windowStart = start.minus({ minutes: 10 })
    const windowEnd   = start.plus({ minutes: 10 })

    // ウィンドウ内か判定（開始±10分）
    if (!(now >= windowStart && now <= windowEnd)) {
      return NextResponse.json({ ok: false, error: 'OUT_OF_WINDOW', windowStart: windowStart.toISO(), windowEnd: windowEnd.toISO() }, { status: 403 })
    }

    // 出席記録（同日重複はユニーク制約で弾かれる）
    const { error: insErr } = await supabaseServer.from('attendance').insert({
      user_code,
      event_id: ev.event_id,
      attended_at: new Date(), // サーバ時刻
      is_valid: true
    })

    if (insErr && !String(insErr.message).includes('uniq_attendance_user_event_day')) {
      return NextResponse.json({ ok: false, error: 'INSERT_FAILED', detail: insErr.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, zoom_url: ev.zoom_url })
  } catch (e:any) {
    return NextResponse.json({ ok: false, error: 'SERVER_ERROR', detail: e?.message }, { status: 500 })
  }
}
