// src/app/api/credits/authorize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { rpcAuthorize } from '@/lib/credits/rpc';
console.log('[authorize] hit'); // 一時的な確認ログ
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // JSON安全パース
    const body = await req.json().catch(() => ({} as any));

    const user_code = String(body?.user_code ?? '').trim();
    const amountRaw = body?.amount;
    const amount = Number(amountRaw);
    const ref = String(body?.ref ?? '').trim();
    const ref_conv = body?.ref_conv == null ? null : String(body.ref_conv);
    const ref_sub  = body?.ref_sub  == null ? null : String(body.ref_sub);

    // 入力チェック
    if (!user_code || !ref || !(amount > 0)) {
      return NextResponse.json(
        { ok: false, error: 'INVALID_BODY', detail: { user_code, amount: amountRaw, ref } },
        { status: 400 },
      );
    }

    // RPC（Supabase Service Role必須）
    const ok = await rpcAuthorize(user_code, amount, ref, ref_conv ?? null, ref_sub ?? null);

    // 残高不足などは 402
    return NextResponse.json(ok ? { ok: true } : { ok: false }, { status: ok ? 200 : 402 });
  } catch (e: any) {
    console.error('[credits/authorize] error:', e?.message || e);
    return NextResponse.json({ ok: false, error: e?.message || 'error' }, { status: 500 });
  }
}
