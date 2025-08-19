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

    // Supabase で uid → user_code
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    if (error || !data?.user_code) {
      return NextResponse.json({ ok: false, error: 'USER_NOT_FOUND' }, { status: 404 })
    }

    // 署名つきクエリ
    const { ts, sig } = makeSignedParams(data.user_code, SHARED_SECRET)
    const query = `user=${encodeURIComponent(data.user_code)}&ts=${ts}&sig=${sig}&from=pay`
    const login_url = `${MU_UI_URL}?${query}`

    return NextResponse.json({ ok: true, user_code: data.user_code, login_url })
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 })
  }
}
