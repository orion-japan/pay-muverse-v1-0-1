import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'
import { makeSignedParams } from '@/lib/signed'

const MU_UI_URL = (process.env.MU_UI_URL ?? 'https://m.muverse.jp').replace(/\/+$/, '')
const SHARED_SECRET = process.env.MU_SHARED_ACCESS_SECRET || ''

export async function POST(req: Request) {
  try {
    const { idToken } = await req.json().catch(() => ({}))
    if (!idToken || typeof idToken !== 'string') {
      return NextResponse.json({ ok: false, error: 'INVALID_TOKEN' }, { status: 400 })
    }

    // Firebase 検証 → uid
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    const firebase_uid = decoded.uid

    // Supabase で uid → user 情報（user_code だけでなく判定に使う列もまとめて取得）
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code, role, click_type, plan_status, is_admin, is_master')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    if (error || !data?.user_code) {
      return NextResponse.json({ ok: false, error: 'USER_NOT_FOUND' }, { status: 404 })
    }

    // 判定用にロワーケースへ
    const role = String(data.role ?? '').toLowerCase()
    const click_type = String(data.click_type ?? '').toLowerCase()
    const plan_status = String(data.plan_status ?? '').toLowerCase()

    // 厳密 truthy 判定（"1"/"true"/1 も true 扱い）
    const truthy = (v: any) => v === true || v === 1 || v === '1' || v === 'true'

    const flagAdmin =
      truthy(data.is_admin) || role === 'admin' || click_type === 'admin' || plan_status === 'admin'

    const flagMaster =
      truthy(data.is_master) ||
      role === 'master' ||
      click_type === 'master' ||
      plan_status === 'master'

    // 署名つきクエリ
    const { ts, sig } = makeSignedParams(data.user_code, SHARED_SECRET)
    const query = `user=${encodeURIComponent(data.user_code)}&ts=${ts}&sig=${sig}&from=pay`
    const login_url = `${MU_UI_URL}?${query}`

    return NextResponse.json({
      ok: true,
      user_code: data.user_code,
      role,                 // 追加：小文字で返却
      click_type,           // 追加
      plan_status,          // 追加
      is_admin: !!flagAdmin,  // 追加：サーバ側で正規化
      is_master: !!flagMaster, // 追加：サーバ側で正規化
      login_url,
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 })
  }
}
