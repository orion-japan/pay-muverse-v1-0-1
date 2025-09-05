import { NextRequest, NextResponse } from 'next/server';
import { logEvent } from '@/server/telemetry';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    // 必須最小限のバリデーション
    if (!body?.kind || !body?.path) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }
    await logEvent({
      kind: body.kind,
      path: body.path,
      status: body.status ?? null,
      latency_ms: body.latency_ms ?? null,
      note: body.note ?? null,
      meta: body.meta ?? null,
      session_id: body.session_id ?? null,
      ua: body.ua ?? req.headers.get('user-agent') ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
