// src/app/api/push-test/route.ts
import { NextResponse } from 'next/server'

// もし Edge Runtime を使いたければコメント解除
export const runtime = 'nodejs' // or 'edge'

const INVOKE_URL = 'https://hcodeoathneftqkmjyoh.supabase.co/functions/v1/sendPush'

export async function POST(req: Request) {
  try {
    const json = await req.json().catch(() => ({}))
    const payload = {
      user_code: json.user_code ?? 'U-CKxc5NQQ',
      title:     json.title     ?? 'Muverse 通知テスト',
      body:      json.body      ?? 'これは Android Chrome のテスト通知です',
      url:       json.url       ?? 'https://muverse.jp/',
    }

    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!key) {
      return NextResponse.json(
        { ok: false, reason: 'Server missing SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500 }
      )
    }

    const res = await fetch(INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Service Role をサーバー側だけで使用（クライアントには出さない）
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    })

    const text = await res.text()
    // Edge Function が text/json どちらでも返せるよう、そのまま透過返却
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    })
  } catch (e: any) {
    return NextResponse.json({ ok: false, reason: String(e?.message ?? e) }, { status: 500 })
  }
}
