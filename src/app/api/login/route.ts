import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { createClient } from '@supabase/supabase-js'

// ✅ Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!
)

export async function POST(req: Request) {
  try {
    const { idToken } = await req.json()
    const decodedToken = await adminAuth.verifyIdToken(idToken)

    console.log('✅ Firebase 認証成功:', decodedToken)

    const email = decodedToken.email
    if (!email) throw new Error('メールアドレスが取得できません')

    // ✅ Supabase から user_code を取得
    const { data, error } = await supabase
      .from('users')
      .select('user_code')
      .eq('click_email', email)
      .single()

    if (error || !data?.user_code) {
      console.error('❌ Supabase ユーザーコード取得失敗:', error)
      return NextResponse.json({ error: 'ユーザーコードが見つかりません' }, { status: 404 })
    }

    const userCode = data.user_code

    // ✅ Cookie に user_code を保存
    const res = NextResponse.json({ success: true })
    res.cookies.set('user_code', userCode, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 1週間
    })

    return res
  } catch (err) {
    console.error('❌ Firebase 認証エラー:', err)
    return NextResponse.json({ error: '認証失敗' }, { status: 500 })
  }
}
