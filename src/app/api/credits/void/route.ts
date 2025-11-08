// src/app/api/credits/void/route.ts
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
    const { error: e2 } = await supa.from('credits_ledger').insert({
      id: randomUUID(),
      user_id,
      amount: Number(amount),
      event: 'void',
      ref: ref || null,
      idempotency_key: idempotency_key || randomUUID(),
    });
    if (e2 && !`${e2.message}`.includes('duplicate key')) throw e2;

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || 'error' }, { status: 500 });
  }
}
