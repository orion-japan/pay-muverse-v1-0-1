import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, action, multiplier, bonus, start_at, end_at, expires_after_days } = body;

    const { data, error } = await supabaseAdmin
      .from('credit_promotions')
      .insert({
        name,
        action,
        multiplier,
        bonus,
        start_at,
        end_at,
        expires_after_days,
      })
      .select('*')
      .single();

    if (error) throw error;
    return NextResponse.json({ ok: true, promo: data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message });
  }
}
