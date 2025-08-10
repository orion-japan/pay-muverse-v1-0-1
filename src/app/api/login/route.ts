export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'
import { makeUserCode } from '@/lib/makeUserCode'

export async function POST(req: NextRequest) {
  try {
    // ヘッダー or ボディどちらでも受け付ける
    const authz = req.headers.get('authorization') || ''
    const headerToken = authz.startsWith('Bearer ') ? authz.slice(7) : ''
    const body = await req.json().catch(() => ({}))
    const token = headerToken || body?.idToken
    if (!token) return NextResponse.json({ error: 'No token' }, { status: 401 })

    const decoded = await adminAuth.verifyIdToken(token, true)
    const firebase_uid = decoded.uid
    const email = decoded.email || null
    const emailVerified = !!decoded.email_verified

    // 既存チェック
    const { data: existing, error: selErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .limit(1)

    if (selErr) {
      return NextResponse.json({ error: selErr.message }, { status: 500 })
    }

    // 無ければ作成
    if (!existing || existing.length === 0) {
      const user_code = await makeUserCode()
      const { error: insErr } = await supabaseServer.from('users').insert([
        { user_code, firebase_uid, click_email: email },
      ])
      if (insErr) {
        return NextResponse.json({ error: insErr.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true, created: true, user_code, email_verified: emailVerified })
    }

    // 既存なら同期
    const user_code = existing[0].user_code as string
    await supabaseServer.from('users').update({ click_email: email }).eq('firebase_uid', firebase_uid)

    return NextResponse.json({ ok: true, created: false, user_code, email_verified: emailVerified })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'login failed' }, { status: 500 })
  }
}
