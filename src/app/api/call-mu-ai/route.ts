import { NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'
import { supabaseServer } from '@/lib/supabaseServer'

const MU_API_URL = process.env.MU_API_URL

export const runtime = 'nodejs'
export const revalidate = 0

export async function POST(req: Request) {
  console.log('========== [call-mu-ai] API開始 ==========')

  try {
    console.log('[call-mu-ai] 🔍 リクエストヘッダー:', Object.fromEntries(req.headers.entries()))
    const body = await req.json().catch(() => ({}))
    console.log('[call-mu-ai] 📥 受信ボディ:', body)

    // ★ 修正：auth.idToken も許容
    const idToken = body?.idToken || body?.auth?.idToken
    const payload = body?.payload || {}

    console.log('[call-mu-ai] ✅ idToken有無:', !!idToken, '｜ payload:', payload)

    if (!idToken) {
      console.error('[call-mu-ai] ❌ idTokenが無いため処理中断')
      return NextResponse.json({ error: 'idTokenが必要です' }, { status: 400 })
    }
    if (!MU_API_URL) {
      console.error('[call-mu-ai] ❌ MU_API_URL未設定')
      return NextResponse.json({ error: 'MU_API_URLが未設定です' }, { status: 500 })
    }

    // Firebase検証
    console.log('[call-mu-ai] 🔍 Firebaseトークン検証開始')
    const decoded = await adminAuth.verifyIdToken(idToken, true)
    console.log('[call-mu-ai] ✅ Firebase検証OK', {
      uid: decoded.uid,
      email: decoded.email,
      issuedAt: decoded.iat,
      expiresAt: decoded.exp,
    })

    // Supabaseで user_code 取得
    console.log('[call-mu-ai] 🔍 Supabaseクエリ開始 (firebase_uid=', decoded.uid, ')')
    const { data: userData, error: sbErr } = await supabaseServer
      .from('users')
      .select('user_code')
      .eq('firebase_uid', decoded.uid)
      .maybeSingle()
    console.log('[call-mu-ai] 📤 Supabaseレスポンス:', { userData, sbErr })

    if (sbErr || !userData?.user_code) {
      console.error('[call-mu-ai] ❌ ユーザー情報取得失敗', sbErr)
      return NextResponse.json({ error: 'user_codeが見つかりません' }, { status: 404 })
    }

    // MU側呼び出し
    const url = `${MU_API_URL}/session/create`
    const reqBody = { user_code: userData.user_code, payload }
    console.log('[call-mu-ai] 📡 MU側API呼び出し開始', { url, reqBody })

    const muRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
    })

    console.log('[call-mu-ai] 📥 MUレスポンスヘッダー:', Object.fromEntries(muRes.headers.entries()))
    const ct = muRes.headers.get('content-type') || ''
    const raw = await muRes.text()
    console.log('[call-mu-ai] 📥 MUレスポンスステータス:', muRes.status)
    console.log('[call-mu-ai] 📥 MUレスポンス本文(先頭500文字):', raw.slice(0, 500))

    let muData: any = null
    try {
      if (ct.includes('application/json') && raw) {
        muData = JSON.parse(raw)
        console.log('[call-mu-ai] ✅ MUレスポンスJSONパース成功')
      } else {
        console.warn('[call-mu-ai] ⚠️ MUレスポンスがJSONではありません')
      }
    } catch (e) {
      console.error('[call-mu-ai] ❌ MUレスポンスJSONパース失敗', e)
    }

    if (!muRes.ok) {
      console.error('[call-mu-ai] ❌ MU_APIエラー', {
        status: muRes.status,
        contentType: ct,
        bodySnippet: raw.slice(0, 2000),
      })
      return NextResponse.json(
        {
          error: 'MU_APIエラー',
          status: muRes.status,
          contentType: ct,
          body: raw.slice(0, 2000),
        },
        { status: 502 }
      )
    }

    console.log('[call-mu-ai] ✅ API処理完了 正常応答返却')
    console.log('========== [call-mu-ai] API終了 ==========')

    return NextResponse.json(
      muData ?? { data: raw, contentType: ct },
      { status: 200 }
    )
  } catch (err: any) {
    console.error('[call-mu-ai] ❌ 例外発生', err)
    console.log('========== [call-mu-ai] API異常終了 ==========')
    return NextResponse.json({ error: 'サーバーエラー', details: err?.message }, { status: 500 })
  }
}
