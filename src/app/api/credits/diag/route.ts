import { NextRequest, NextResponse } from 'next/server';
import { rpcCapture } from '@/lib/credits/rpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { user_code, amount, ref } = await req.json();
    const ok = await rpcCapture(String(user_code), Number(amount), String(ref));

    const res = NextResponse.json(
      ok ? { ok: true } : { ok: false },
      { status: ok ? 200 : 402 }
    );
    res.headers.set('x-handler', 'app/credits/capture'); // ← 署名
    return res;
  } catch (e: any) {
    const res = NextResponse.json(
      { ok: false, error: e?.message || 'bad_request' },
      { status: 400 }
    );
    res.headers.set('x-handler', 'app/credits/capture');
    return res;
  }
}
