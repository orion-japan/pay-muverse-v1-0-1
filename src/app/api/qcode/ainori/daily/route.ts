import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { calcAinoriQForDate } from '@/lib/qcode/ainori';

// POST { user_code, date? }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body.user_code || '').trim();
    if (!user_code)
      return NextResponse.json({ ok: false, error: 'user_code required' }, { status: 400 });

    const forDate =
      String(body.date || '').trim() ||
      new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const result = await calcAinoriQForDate(user_code, forDate);

    const q_code = {
      q: result.q,
      confidence: result.confidence,
      hint: result.hint,
      color_hex: result.color_hex,
      version: 'qmap.v0.3.2',
      by: 'sofia',
      meta: { source: 'ainori-daily', ...result.meta },
    };

    const { data, error } = await supabaseAdmin
      .from('q_code_logs')
      .insert([{ user_code, source_type: 'event', intent: 'ainori', q_code }])
      .select('id,created_at')
      .single();

    if (error) throw error;
    return NextResponse.json({
      ok: true,
      id: data.id,
      created_at: data.created_at,
      q: result.q,
      meta: result.meta,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
