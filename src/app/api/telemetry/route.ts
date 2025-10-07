import { NextRequest, NextResponse } from 'next/server';
import { logEvent } from '@/server/telemetry';

export async function POST(req: NextRequest) {
  try {
    // JSON パース失敗対策
    const body = await req.json().catch(() => null);
    if (!body || !body.kind || !body.path) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 });
    }

    // user_code を受け取れるように
    await logEvent({
      user_code: body.user_code ?? null,
      kind: body.kind,
      path: body.path,
      status: body.status ?? null,
      latency_ms: body.latency_ms ?? null,
      note: body.note ?? null,
      meta: body.meta ?? null,
      session_id: body.session_id ?? null,
      ua: body.ua ?? req.headers.get('user-agent') ?? null,
    });

    // 追跡APIは 204 で十分（ボディ不要）
    return new NextResponse(null, { status: 204 });
  } catch (e: any) {
    // 失敗理由を可視化
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
