import { NextRequest, NextResponse } from 'next/server';
import { rpcAuthorize } from '@/lib/credits/rpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest) {
  try {
    const user_code = '669933';
    const amount = 5;
    const ref = 'ref_demo_3';
    const ref_conv = 'conv_demo';

    const ok = await rpcAuthorize(user_code, amount, ref, ref_conv, null);
    return NextResponse.json({ ok, via: 'authorize/test' }, { status: ok ? 200 : 402 });
  } catch (e: any) {
    // 403 等の具体的なコードをメッセージに含めて返す
    return NextResponse.json(
      { ok: false, error: e?.message || 'error', via: 'authorize/test' },
      { status: 500 },
    );
  }
}
