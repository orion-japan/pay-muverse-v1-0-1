import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => null)
    const token = body?.idToken
    if (!token) {
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // Firebaseトークン検証
    const decoded = await adminAuth.verifyIdToken(token, true)
    const firebase_uid = decoded.uid

    // Supabaseから user_code を取得
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code, click_email, card_registered, payjp_customer_id')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // ts と sig の生成
    const b64 = process.env.MU_SECRET_KEY_BASE64
    if (!b64) {
      return NextResponse.json({ error: 'server misconfiguration' }, { status: 500 })
    }
    const ts = Date.now().toString()
    const secretKey = Buffer.from(b64, 'base64').toString('utf8')
    const sig = crypto.createHmac('sha256', secretKey)
      .update(`${data.user_code}${ts}`)
      .digest('hex')

    return NextResponse.json({ user: data, ts, sig }, { status: 200 })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 })
  }
}
