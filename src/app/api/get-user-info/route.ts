// app/api/get-user-info/route.ts
import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'

export async function POST(req: Request) {
  console.log('========== [get-user-info] API開始 ==========')

  try {
    console.log('[get-user-info] 🔍 リクエストヘッダー:', Object.fromEntries(req.headers.entries()))

    const body = await req.json().catch(() => ({}))
    console.log('[get-user-info] 📥 受信ボディ:', body)

    // 受信ボディ確認
console.log('[get-user-info] 📥 受信ボディ:', body)

// idToken 取得（直下 or auth.idToken）
const idToken = body?.idToken || body?.auth?.idToken
console.log('[get-user-info] ✅ idToken有無:', !!idToken)


    if (!idToken) {
      console.error('[get-user-info] ❌ idTokenが無いため処理中断')
      console.log('========== [get-user-info] API終了 ==========')
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // Firebaseトークン検証
    console.log('[get-user-info] 🔍 Firebaseトークン検証開始')
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    console.log('[get-user-info] ✅ Firebase検証OK', {
      uid: decoded.uid,
      email: decoded.email,
      issuedAt: decoded.iat,
      expiresAt: decoded.exp,
    })
    const firebase_uid = decoded.uid

    // Supabaseから user_code を取得
    console.log('[get-user-info] 🔍 Supabaseクエリ開始 (firebase_uid=', firebase_uid, ')')
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle()

    console.log('[get-user-info] 📤 Supabaseレスポンス:', { data, error })

    if (error || !data?.user_code) {
      console.error('[get-user-info] ❌ ユーザー情報取得失敗', error)
      console.log('========== [get-user-info] API終了 ==========')
      return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 404 })
    }

    // login_urlを生成
    const login_url = `https://m.muverse.jp?user_code=${data.user_code}`
    console.log('[get-user-info] 🔗 login_url生成:', login_url)

    console.log('[get-user-info] ✅ API処理完了 正常応答返却')
    console.log('========== [get-user-info] API終了 ==========')

    return NextResponse.json({ login_url })
  } catch (err: any) {
    console.error('[get-user-info] ❌ 例外発生', err)
    console.log('========== [get-user-info] API異常終了 ==========')
    return NextResponse.json({ error: err.message || 'サーバーエラー' }, { status: 500 })
  }
}

