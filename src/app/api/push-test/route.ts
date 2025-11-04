// /app/api/push-test/route.ts
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const INVOKE_URL = 'https://hcodeoathneftqkmjyoh.supabase.co/functions/v1/sendPush';

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) {
      console.error('[push-test] missing SUPABASE_SERVICE_ROLE_KEY');
      return NextResponse.json(
        { ok: false, reason: 'Server missing SUPABASE_SERVICE_ROLE_KEY' },
        { status: 500, headers: corsHeaders() },
      );
    }

    const input = await req.json().catch(() => ({}) as any);
    const payload = {
      user_code: input.user_code ?? 'U-CKxc5NQQ',
      title: input.title ?? 'Muverse 通知テスト',
      body: input.body ?? 'これは通知のテストです',
      url: input.url ?? 'https://muverse.jp/',
      tag: input.tag ?? 'debug-test',
    };

    console.log('[push-test] inbound payload:', payload);

    const supaRes = await fetch(INVOKE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await supaRes.text();
    const tookMs = Date.now() - startedAt;

    console.log('[push-test] supabase status:', supaRes.status);
    console.log('[push-test] supabase body:', text);

    return new NextResponse(text, {
      status: supaRes.status,
      headers: {
        'content-type': supaRes.headers.get('content-type') ?? 'application/json',
        'x-push-proxy-time': String(tookMs),
        ...corsHeaders(),
      },
    });
  } catch (e: any) {
    console.error('[push-test] error:', e?.stack || e?.message || e);
    return NextResponse.json(
      { ok: false, reason: String(e?.message ?? e) },
      { status: 500, headers: corsHeaders() },
    );
  }
}
