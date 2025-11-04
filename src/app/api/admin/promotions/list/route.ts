import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(_req: NextRequest) {
  try {
    const { data, error } = await supabaseAdmin
      .from('credit_promotions')
      .select('*')
      .order('start_at', { ascending: false });
    if (error) throw error;
    return NextResponse.json({ ok: true, items: data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message ?? 'unknown' }, { status: 500 });
  }
}
