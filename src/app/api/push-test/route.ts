// app/api/push-test/route.ts
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'        // or 'edge'
export const dynamic = 'force-dynamic' // キャッシュ回避（ログ確認しやすくする）

const INVOKE_URL =
  'https://hcodeoathneftqkmjyoh.supabase.co/functions/v1/sendPush'

/** 共通で付ける CORS ヘッダ（必要に応じてドメイン絞ってOK） */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

/** CORS: プリフライトへの応答 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

/** 実処理（ブラウザからは POST で来る） */
export async function POST(req: Request) {
  const startedAt = Date.now()
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) {
      console.error('[push-test] missing SUPABASE_SERVICE_ROLE_KEY')
      return NextResponse.json(
        { ok: false, reason: 'Server missing SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500, headers: corsHeaders() },
      )
    }

    // リクエスト JSON を受け取り（空ならデフォルト）
    const input = await req.json().catch(() => ({} as any))
    const payload = {
      user_code: input.user_code ?? 'U-CKxc5NQQ',
      title:     input.title     ?? 'Muverse 通知テスト',
      body:      input.body      ?? 'これは Android Chrome のテスト通知です',
      url:       input.url       ?? 'https://muverse.jp/',
    }

    // サーバーログ（Vercel/Node のログに出ます）
    console.log('[push-test] inbound payload:', payload)

    // Supabase Edge Function へフォワード
    const supaRes = await fetch(INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`, // Service Role はサーバー内だけで使用
      },
      body: JSON.stringify(payload),
    })

    const text = await supaRes.text()
    const tookMs = Date.now() - startedAt

    // 詳細ログ（レスポンスの status / body も記録）
    console.log('[push-test] supabase status:', supaRes.status)
    // 返り値が長い場合もあるので一部だけ出す：必要ならそのまま text を出してOK
    console.log('[push-test] supabase body:', text)

    return new NextResponse(text, {
      status: supaRes.status,
      headers: {
        'content-type': supaRes.headers.get('content-type') ?? 'application/json',
        'x-push-proxy-time': String(tookMs),
        ...corsHeaders(),
      },
    })
  } catch (e: any) {
    console.error('[push-test] error:', e?.stack || e?.message || e)
    return NextResponse.json(
      { ok: false, reason: String(e?.message ?? e) },
      { status: 500, headers: corsHeaders() },
    )
  }
}
