import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'

const MU_API_URL = process.env.MU_API_URL

export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(req: Request) {
  console.log('[call-mu-ai] API開始')

  try {
    const body = await req.json().catch(() => ({}))
    const idToken = body?.idToken
    const payload = body?.payload || {}

    console.log('[call-mu-ai] 受信データ:', { hasIdToken: !!idToken })

    if (!idToken) {
      return NextResponse.json({ error: 'idTokenが必要です' }, { status: 400 })
    }
    if (!MU_API_URL) {
      return NextResponse.json({ error: 'MU_API_URLが未設定です' }, { status: 500 })
    }

    // Firebase検証
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    console.log('[call-mu-ai] Firebase検証OK uid=', decoded.uid)

    // Supabaseで user_code 取得
    const { data: userData, error: sbErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', decoded.uid)
      .maybeSingle()

    if (sbErr || !userData?.user_code) {
      console.error('[call-mu-ai] ユーザー情報取得失敗', sbErr)
      return NextResponse.json({ error: 'user_codeが見つかりません' }, { status: 404 })
    }

    // MU側呼び出し
    const url = `${MU_API_URL}/session/create`
    const reqBody = { user_code: userData.user_code, payload }
    console.log('📤 MUへPOST', { url, body: reqBody })

    const muRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 認証が必要ならここに Authorization 等を追加
      body: JSON.stringify(reqBody),
    })

    const ct = muRes.headers.get('content-type') || ''
    const raw = await muRes.text() // まず生で読む
    let muData: any = null
    try {
      if (ct.includes('application/json') && raw) {
        muData = JSON.parse(raw)
      }
    } catch (e) {
      // JSONでない/壊れてる場合はそのまま raw を返す
    }

    console.log('📥 MUレス', { status: muRes.status, ct, rawSnippet: raw.slice(0, 500) })

    if (!muRes.ok) {
      return NextResponse.json(
        {
          error: 'MU_APIエラー',
          status: muRes.status,
          contentType: ct,
          body: raw.slice(0, 2000),
        },
        { status: 502 } // ゲートウェイ的エラーに寄せる
      )
    }

    // 正常時：JSONならそのまま、JSONでなければrawを包んで返す
    return NextResponse.json(
      muData ?? { data: raw, contentType: ct },
      { status: 200 }
    )
  } catch (err: any) {
    console.error('[call-mu-ai] 例外発生', err)
    return NextResponse.json({ error: 'サーバーエラー', details: err?.message }, { status: 500 })
  }
}
