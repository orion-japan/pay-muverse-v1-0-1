// /src/app/api/credits/power-meter/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { action = 'daily', base = 45, user_code } = body ?? {};
    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'missing: user_code' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc('compute_credit_for_action', {
      p_action: action,
      p_base_amount: base,
      p_user_code: user_code,
    });

    if (error) throw new Error(error.message);

    // data は rows。最初の1件を返す
    const row = Array.isArray(data) ? data[0] : data;
    return NextResponse.json({
      ok: true,
      amount: row.amount,
      expires_at: row.expires_at,
      promo_id: row.promo_id,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
