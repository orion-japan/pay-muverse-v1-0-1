import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'
import crypto from 'crypto'

export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(req: Request) {
  console.log('--- [PAY] /api/get-user-info START ---')

  try {
    const body = await req.json().catch(() => null)
    console.log('① 受信ボディ:', body)

    const token = body?.idToken
    if (!token) {
      console.error('❌ idToken が未送信')
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // Firebaseトークン検証
    console.log('② Firebaseトークン検証開始')
    const decoded = await adminAuth.verifyIdToken(token, true)
    console.log('③ Firebase検証成功:', decoded)

    const firebase_uid = decoded.uid

    // Supabaseから user_code を取得
    console.log('④ Supabase検索開始 uid=', firebase_uid)
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code, click_email, card_registered, payjp_customer_id')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    console.log('⑤ Supabase結果:', { data, error })

    if (error) {
      console.error('❌ Supabaseエラー', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      console.error('❌ ユーザー見つからず')
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // ts と sig の生成
    console.log('⑥ ts/sig生成開始')
    const b64 = process.env.MU_SECRET_KEY_BASE64
    if (!b64) {
      console.error('❌ MU_SECRET_KEY_BASE64 未設定')
      return NextResponse.json({ error: 'server misconfiguration' }, { status: 500 })
    }

    const ts = Date.now().toString()
    const secretKey = Buffer.from(b64, 'base64').toString('utf8')
    const sig = crypto.createHmac('sha256', secretKey)
      .update(`${data.user_code}${ts}`)
      .digest('hex')

    console.log('⑦ ts/sig生成完了:', { ts, sig })

    console.log('--- [PAY] /api/get-user-info END ---')
    return NextResponse.json({ user: data, ts, sig }, { status: 200 })
  } catch (e: any) {
    console.error('❌ Server error:', e)
    return NextResponse.json({ error: e?.message || 'Server error' }, { status: 500 })
  }
}
