// src/app/api/credits/capture/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminClient } from '@/lib/credits/db';
import { randomUUID } from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const { user_id, amount, ref, idempotency_key } = await req.json();
    if (!user_id || !amount || amount <= 0) {
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }
    const supa = adminClient();

    // 残高減算（負残高禁止）
    const { data, error } = await supa.rpc('debit_sofia_credit', {
      p_user_id: user_id,
      p_amount: Number(amount),
    });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 400 });

    // 台帳
    const { error: e2 } = await supa.from('credits_ledger').insert({
      id: randomUUID(),
      user_id,
      amount: Number(amount) * -1,
      event: 'capture',
      ref: ref || null,
      idempotency_key: idempotency_key || randomUUID(),
    });
    if (e2 && !`${e2.message}`.includes('duplicate key')) throw e2;

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'error' }, { status: 500 });
  }
}
