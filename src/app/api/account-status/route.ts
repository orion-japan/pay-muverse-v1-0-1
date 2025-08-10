export const runtime = 'nodejs'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminAuth } from '@/lib/firebase-admin'

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('ENV CHECK account-status:', {
    url: !!SUPABASE_URL,
    sr: !!SERVICE_ROLE,
    srLen:
      (process.env.SUPABASE_SERVICE_ROLE ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        '').length,
  })
  throw new Error('Env missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE')
}
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } })

type UserRow = {
  user_code: string
  click_type: string | null
  card_registered: boolean | null
  payjp_customer_id: string | null
  sofia_credit: number | null
  click_email: string | null
  email_verified: boolean | null
  firebase_uid?: string | null
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization') || ''
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
    if (!token) {
      return NextResponse.json({ error: '認証トークンがありません' }, { status: 401 })
    }

    let decoded: any
    try {
      decoded = await adminAuth.verifyIdToken(token, true)
    } catch {
      return NextResponse.json({ error: '無効なトークンです' }, { status: 403 })
    }
    const firebase_uid: string = decoded.uid
    const email: string | null = decoded.email ?? null

    // uid で検索
    let { data, error } = await supabase
      .from('users')
      .select('user_code, click_type, card_registered, payjp_customer_id, sofia_credit, click_email, email_verified, firebase_uid')
      .eq('firebase_uid', firebase_uid)
      .single<UserRow>()

    // 無ければ email で再検索 → uid 同期
    if ((!data || error) && email) {
      const retry = await supabase
        .from('users')
        .select('user_code, click_type, card_registered, payjp_customer_id, sofia_credit, click_email, email_verified, firebase_uid')
        .eq('click_email', email)
        .single<UserRow>()
      data = retry.data as UserRow | null
      error = retry.error
      if (data && (!data.firebase_uid || data.firebase_uid !== firebase_uid)) {
        await supabase.from('users').update({ firebase_uid }).eq('user_code', data.user_code)
      }
    }

    if (error || !data) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json({
      user_code: data.user_code,
      click_type: data.click_type ?? '',
      card_registered: data.card_registered === true,
      payjp_customer_id: data.payjp_customer_id ?? null,
      sofia_credit: data.sofia_credit ?? 0,
      click_email: data.click_email ?? '',
      email_verified: data.email_verified === true,
    })
  } catch (err: any) {
    console.error('account-status POST error:', err?.message || err)
    return NextResponse.json({ error: '認証エラー' }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const user_code = searchParams.get('user')
    if (!user_code) {
      return NextResponse.json({ error: 'No user_code provided' }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('users')
      .select('user_code, click_type, card_registered, payjp_customer_id, sofia_credit, click_email, email_verified')
      .eq('user_code', user_code)
      .single<UserRow>()

    if (error || !data) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json({
      user_code: data.user_code,
      click_type: data.click_type ?? '',
      card_registered: data.card_registered === true,
      payjp_customer_id: data.payjp_customer_id ?? null,
      sofia_credit: data.sofia_credit ?? 0,
      click_email: data.click_email ?? '',
      email_verified: data.email_verified === true,
    })
  } catch (err: any) {
    console.error('account-status GET error:', err?.message || err)
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 })
  }
}
