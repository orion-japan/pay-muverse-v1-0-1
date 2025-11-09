import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
  // 実運用ではDB保存。今は受け取ってOK返すだけ
  const body = await req.json().catch(() => ({}));
  if (!body?.userCode || !body?.subscription) {
    return NextResponse.json({ ok: false, error: 'missing_params' }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
