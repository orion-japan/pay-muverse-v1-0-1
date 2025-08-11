// src/app/api/get-user-info/route.ts
import { NextResponse } from 'next/server'
import { supabaseServer } from '@/lib/supabaseServer' // ← 修正：サーバー権限でアクセス
import crypto from 'crypto'

// ← Node.js ランタイムを強制（crypto使用のため）
export const runtime = 'nodejs'
// ← キャッシュさせない（毎回最新）
export const revalidate = 0

export async function POST(req: Request) {
  try {
    // リクエストボディの取得
    const body = await req.json().catch(() => null)
    const user_code = body?.user_code

    if (!user_code) {
      return NextResponse.json(
        { error: 'user_code is required' },
        { status: 400 }
      )
    }

    // Supabaseから必要なカラムのみ取得（サーバー権限）
    const { data, error } = await supabaseServer
      .from('users')
      .select('user_code, click_email, card_registered, payjp_customer_id')
      .eq('user_code', user_code)
      .maybeSingle() // 0件時は null を返す

    if (error) {
      console.error('❌ Supabase error:', error)
      return NextResponse.json(
        { error: 'ユーザー情報の取得に失敗しました' },
        { status: 500 }
      )
    }

    if (!data) {
      return NextResponse.json(
        { error: 'ユーザーが存在しません' },
        { status: 404 }
      )
    }

    // 鍵チェック（未設定だと500）
    const b64 = process.env.MU_SECRET_KEY_BASE64
    if (!b64) {
      console.error('❌ MU_SECRET_KEY_BASE64 is missing')
      return NextResponse.json(
        { error: 'server misconfiguration' },
        { status: 500 }
      )
    }

    // ts と sig の生成
    const ts = Date.now().toString()
    const secretKey = Buffer.from(b64, 'base64').toString('utf8')
    const sig = crypto
      .createHmac('sha256', secretKey)
      .update(`${user_code}${ts}`)
      .digest('hex')

    // 正常レスポンス
    return NextResponse.json(
      {
        user: data,
        ts,
        sig,
      },
      { status: 200 }
    )
  } catch (e) {
    console.error('❌ API exception:', e)
    return NextResponse.json(
      { error: 'サーバーエラーが発生しました' },
      { status: 500 }
    )
  }
}

// GETメソッドは許可しない
export async function GET() {
  return NextResponse.json({ error: 'Method Not Allowed' }, { status: 405 })
}
