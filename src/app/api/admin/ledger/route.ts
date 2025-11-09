import { NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const { data, error } = await admin
    .from('credits_ledger')
    .select('created_at, user_code, amount, kind, ref, balance_after')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ ok:false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok:true, items: data });
}
