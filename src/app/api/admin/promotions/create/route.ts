import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const {
      name,
      action,
      multiplier,
      bonus,
      start_at,
      end_at,
      expires_after_days,
      applies_to_group_id = null,
      applies_to_user_code = null,
      priority = 100,
    } = b ?? {};
    if (!name || !action || !start_at || !end_at) {
      return NextResponse.json(
        { ok: false, error: 'missing: name/action/start_at/end_at' },
        { status: 400 },
      );
    }
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
        applies_to_group_id,
        applies_to_user_code,
        priority,
        is_active: true,
      })
      .select('*')
      .single();
    if (error) throw error;
    return NextResponse.json({ ok: true, promo: data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message ?? 'unknown' }, { status: 500 });
  }
}
