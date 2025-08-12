// app/api/send-token/route.ts
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  console.log('=== [SEND_TOKEN] API開始 ===')

  try {
    const body = await req.json().catch(() => ({}))
    console.log('[SEND_TOKEN] 📥 受信ボディ:', body)

    const idToken = body?.idToken
    console.log('[SEND_TOKEN] ✅ idToken有無:', !!idToken)

    if (!idToken) {
      console.error('[SEND_TOKEN] ❌ idTokenが無いため処理中断')
      return NextResponse.json({ error: 'idToken is required' }, { status: 400 })
    }

    // ベースURLを動的に決定
    const baseUrl =
      process.env.BASE_URL ||
      (req.headers.get('x-forwarded-proto') && req.headers.get('x-forwarded-host')
        ? `${req.headers.get('x-forwarded-proto')}://${req.headers.get('x-forwarded-host')}`
        : '')
    console.log('[SEND_TOKEN] 🌐 APIベースURL:', baseUrl || '(相対パス使用)')

    // 1. get-user-info 呼び出し
    console.log('[SEND_TOKEN] 📡 /api/get-user-info 呼び出し開始')
    const getUserInfoRes = await fetch(`${baseUrl}/api/get-user-info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }), // get-user-info はこの形
    })
    console.log('[SEND_TOKEN] 📥 get-user-info ステータス:', getUserInfoRes.status)
    const getUserInfoData = await getUserInfoRes.json().catch(() => ({}))
    console.log('[SEND_TOKEN] 📦 get-user-info レスポンス:', getUserInfoData)

    // 2. call-mu-ai 呼び出し
    console.log('[SEND_TOKEN] 📡 /api/call-mu-ai 呼び出し開始')
    const callMuAiRes = await fetch(`${baseUrl}/api/call-mu-ai`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth: { mode: 'firebase', idToken },
      }),
    })
    console.log('[SEND_TOKEN] 📥 call-mu-ai ステータス:', callMuAiRes.status)
    const callMuAiData = await callMuAiRes.json().catch(() => ({}))
    console.log('[SEND_TOKEN] 📦 call-mu-ai レスポンス:', callMuAiData)

    // レスポンスまとめ
    const responseData = {
      status: 'ok',
      getUserInfo: getUserInfoData,
      callMuAi: callMuAiData,
    }
    console.log('[SEND_TOKEN] ✅ API処理完了 正常応答返却:', responseData)

    return NextResponse.json(responseData)
  } catch (err: any) {
    console.error('[SEND_TOKEN] ❌ 例外発生', err)
    return NextResponse.json(
      { error: err.message || 'Internal Server Error' },
      { status: 500 }
    )
  }
}
