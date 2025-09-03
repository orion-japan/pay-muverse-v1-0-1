import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import admin from 'firebase-admin'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Firebase Admin 初期化
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  })
}

export async function POST(req: NextRequest) {
  const { user_code } = await req.json()
  if (!user_code) {
    return NextResponse.json({ ok: false, error: 'user_code is required' }, { status: 400 })
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('firebase_uid, payjp_customer_id')
    .eq('user_code', user_code)
    .single()

  if (error || !user) {
    return NextResponse.json({ ok: false, error: 'User not found' }, { status: 404 })
  }

  const results: Record<string, string> = {}

  // Firebase 削除
  try {
    if (user.firebase_uid) {
      await admin.auth().deleteUser(user.firebase_uid)
      results.firebase = 'deleted'
    } else {
      results.firebase = 'skipped (no firebase_uid)'
    }
  } catch (err: any) {
    results.firebase = `error: ${err.message}`
  }

  // Supabase 削除
  try {
    await supabase.from('users').delete().eq('user_code', user_code)
    results.supabase = 'deleted'
  } catch (err: any) {
    results.supabase = `error: ${err.message}`
  }

  // PAYJP は削除せず、存在するかどうかだけ返す
  if (user.payjp_customer_id) {
    results.payjp = 'customer exists (not deleted)'
  } else {
    results.payjp = 'none'
  }

  return NextResponse.json({ ok: true, results })
}
