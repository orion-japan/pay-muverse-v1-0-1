// src/app/api/verify-complete/route.ts

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { adminAuth } from '@/lib/firebase-admin'

// ✅ Supabase初期化（Service Role使用）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(req: NextRequest) {
  try {
    // 🔹 Authorization ヘッダーから ID トークン取得
    const authHeader = req.headers.get('authorization')
    const token = authHeader?.replace(/^Bearer\s+/i, '')

    if (!token) {
      return NextResponse.json({ success: false, error: 'Authorization ヘッダーが必要です' }, { status: 401 })
    }

    // 🔹 Firebaseトークン検証
    let decoded
    try {
      decoded = await adminAuth.verifyIdToken(token)
    } catch (verifyErr) {
      console.error('❌ Firebaseトークン検証失敗:', verifyErr)
      return NextResponse.json({ success: false, error: '無効なトークンです' }, { status: 403 })
    }

    // 🔹 Firebase側も認証済みか確認
    if (!decoded.email_verified) {
      return NextResponse.json({ success: false, error: 'Firebase側でメール未認証です' }, { status: 400 })
    }

    const firebase_uid = decoded.uid

    // ✅ Supabase側を更新
    const { error } = await supabase
      .from('users')
      .update({ email_verified: true })
      .eq('firebase_uid', firebase_uid)

    if (error) {
      console.error('❌ Supabase更新エラー:', error)
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (err: any) {
    console.error('❌ 予期しないエラー:', err)
    return NextResponse.json({ success: false, error: '内部エラー' }, { status: 500 })
  }
}
