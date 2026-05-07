import { NextRequest, NextResponse } from 'next/server';

// src/app/api/webhook/route.ts
// Legacy PAY.JP webhook endpoint.
//
// 以前は subscription.created / subscription.updated を受けると
// click_type を無条件で premium に上書きしていた。
// 現在の課金反映は /api/pay/webhook → /api/pay/plan/apply に集約するため、
// この legacy endpoint では署名確認後、受信だけしてDB更新しない。

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-payjp-webhook-token');

  if (token !== process.env.PAYJP_WEBHOOK_SECRET) {
    return new NextResponse('Invalid signature', { status: 400 });
  }

  const payload = await req.json().catch(() => null);

  console.log('[legacy webhook noop]', {
    type: payload?.type ?? null,
    event_id: payload?.id ?? null,
  });

  return NextResponse.json({
    received: true,
    legacy_noop: true,
  });
}
