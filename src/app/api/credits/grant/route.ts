import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export async function POST(req: NextRequest) {
  const { user_code, amount, ref } = await req.json().catch(()=>({}));
  if (!user_code || !amount) return NextResponse.json({ ok:false, error:'bad_request' }, { status:400 });

  const { data, error } = await admin.rpc('credit_grant', {
    p_user_code: String(user_code),
    p_amount: Number(amount),
    p_ref: String(ref ?? `grant-${crypto.randomUUID()}`),
    p_meta: {},
  });

  if (error) return NextResponse.json({ ok:false, error: error.message }, { status:500 });
  return NextResponse.json({ ok:true, rpc: data });
}
