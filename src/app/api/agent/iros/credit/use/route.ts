// /src/app/api/agent/iros/credit/use/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { uid } = await verifyFirebaseAndAuthorize(req); // uid を取得
    const { amount = 1, meta = {} } = await req.json().catch(() => ({}));

    if (!uid) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (amount <= 0) {
      return NextResponse.json({ ok: false, error: 'amount must be > 0' }, { status: 400 });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

    // ① 推奨: 既存のRPCがある場合（例: credit_use）
    // const { data, error } = await supa.rpc('credit_use', { p_user_id: uid, p_amount: amount, p_meta: meta });

    // ② 直更新（SSOT: users.sofia_credit）+ 台帳追記（credits_ledger）
    const { data: userRow, error: selErr } = await supa
      .from('users')
      .select('id, sofia_credit')
      .eq('id', uid)
      .single();

    if (selErr) throw selErr;
    const current = userRow?.sofia_credit ?? 0;
    if (current < amount) {
      return NextResponse.json({ ok: false, error: 'INSUFFICIENT_CREDIT' }, { status: 402 });
    }

    const newBal = current - amount;

    const { error: updErr } = await supa
      .from('users')
      .update({ sofia_credit: newBal })
      .eq('id', uid);

    if (updErr) throw updErr;

    // 台帳
    await supa.from('credits_ledger').insert({
      user_id: uid,
      delta: -amount,
      reason: 'iros.reply',
      meta,
    });

    return NextResponse.json({ ok: true, balance: newBal });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e?.message || 'Internal Error' }, { status: 500 });
  }
}
