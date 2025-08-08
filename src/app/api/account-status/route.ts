// src/app/api/account-status/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminAuth } from '@/lib/firebase-admin'

// Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
)

type UserData = {
  user_code: string
  click_type: string
  card_registered: boolean
  payjp_customer_id: string | null
  sofia_credit: number | null
  click_email: string | null
  email_verified: boolean | null
}

// ✅ POST（Firebase IDトークン → UID or Email で Supabase 照会）
export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '')

    if (!token) {
      console.error('❌ Authorization ヘッダーなし')
      return NextResponse.json({ error: '認証トークンがありません' }, { status: 401 })
    }

    // Firebaseトークン検証
    let decoded
    try {
      decoded = await adminAuth.verifyIdToken(token)
      console.log('✅ Firebaseトークンデコード結果:', decoded)
    } catch (verifyErr) {
      console.error('❌ Firebaseトークン検証失敗:', verifyErr)
      return NextResponse.json({ error: '無効なトークンです' }, { status: 403 })
    }

    const firebase_uid = decoded.uid
    const email = decoded.email

    // UIDで Supabase 照会
    let { data, error } = await supabase
      .from('users')
      .select(`
        user_code,
        click_type,
        card_registered,
        payjp_customer_id,
        sofia_credit,
        click_email,
        email_verified
      `)
      .eq('firebase_uid', firebase_uid)
      .single()

    // UIDで見つからなければ email で再検索
    if ((!data || error) && email) {
      console.warn('⚠️ UIDで見つからず、emailで再検索:', email)
      const retry = await supabase
        .from('users')
        .select(`
          user_code,
          click_type,
          card_registered,
          payjp_customer_id,
          sofia_credit,
          click_email,
          email_verified
        `)
        .eq('click_email', email)
        .single()

      data = retry.data
      error = retry.error
    }

    if (error || !data) {
      console.error('❌ Supabase照会失敗:', error)
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    return NextResponse.json({
      user_code: data.user_code,
      click_type: data.click_type,
      card_registered: data.card_registered === true,
      payjp_customer_id: data.payjp_customer_id ?? null,
      sofia_credit: data.sofia_credit ?? 0,
      click_email: data.click_email ?? '',
      email_verified: data.email_verified === true,
    })
  } catch (err) {
    console.error('❌ API内部エラー:', err)
    return NextResponse.json({ error: '認証エラー' }, { status: 500 })
  }
}

// ✅ GET（従来通り user_code による取得）
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const user_code = searchParams.get('user')

  if (!user_code) {
    return NextResponse.json({ error: 'No user_code provided' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('users')
    .select(`
      user_code,
      click_type,
      card_registered,
      payjp_customer_id,
      sofia_credit,
      click_email,
      email_verified
    `)
    .eq('user_code', user_code)
    .single()

  if (error || !data) {
    console.error('❌ Supabase error (GET):', error)
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  return NextResponse.json({
    user_code: data.user_code,
    click_type: data.click_type,
    card_registered: data.card_registered === true,
    payjp_customer_id: data.payjp_customer_id ?? null,
    sofia_credit: data.sofia_credit ?? 0,
    click_email: data.click_email ?? '',
    email_verified: data.email_verified === true,
  })
}
