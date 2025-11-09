import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { user_code, amount, ref, ref_conv } = body || {};
    if (!user_code || !amount || !ref) {
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }

    const { data, error } = await admin.rpc('credit_authorize', {
      p_user_code: String(user_code),
      p_amount: Number(amount),
      p_ref: String(ref),
    });

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true, rpc: data, echo: { user_code, amount, ref, ref_conv } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
