import { NextRequest, NextResponse } from 'next/server';
import { rpcCaptureDirectProbe } from '@/lib/credits/rpc';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = req.nextUrl.searchParams.get('user') ?? '669933';
  const amt = Number(req.nextUrl.searchParams.get('amt') ?? '1');
  const ref = req.nextUrl.searchParams.get('ref') ?? 'probe-' + Date.now();

  const attempts = await rpcCaptureDirectProbe(String(user), amt, String(ref));
  return NextResponse.json({ ok: true, user, amt, ref, attempts });
}
