// app/api/push-test/route.ts
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const INVOKE_URL =
  'https://hcodeoathneftqkmjyoh.supabase.co/functions/v1/sendPush'

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() })
}

function looksLikeUUID(v?: string) {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
}

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

    const input = await req.json().catch(() => ({} as any))
    const uid: string | undefined = input.uid
    const user_code: string | undefined = input.user_code

    // Edge側の仕様: uid を優先。無ければ UUID っぽい user_code のみ許可
    const forward: any = {
      title:  input.title  ?? 'Muverse 通知テスト',
      body:   input.body   ?? 'これは iPhone/Android PWA のテスト通知です',
      url:    input.url    ?? 'https://muverse.jp/',
      tag:    input.tag    ?? 'muverse',
    }
    if (uid) {
      forward.uid = uid
    } else if (looksLikeUUID(user_code)) {
      forward.user_code = user_code
    } else {
      return NextResponse.json(
        { ok: false, reason: 'require uid or uuid-like user_code' },
        { status: 400, headers: corsHeaders() },
      )
    }

    console.log('[push-test] inbound payload:', forward)

    const supaRes = await fetch(INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(forward),
    })

    const text = await supaRes.text()
    const tookMs = Date.now() - startedAt
    console.log('[push-test] supabase status:', supaRes.status)
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
