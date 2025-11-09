import { NextRequest, NextResponse } from 'next/server';
import { admin } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || '';
  if (!user_code) {
    return NextResponse.json({ ok: false, error: 'missing_user_code' }, { status: 400 });
  }
  const { data, error } = await admin.rpc('credit_get_balance', { p_user_code: user_code });
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, balance: Number(data ?? 0) });
}
