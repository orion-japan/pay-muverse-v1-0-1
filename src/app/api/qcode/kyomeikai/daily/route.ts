import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { calcKyomeikaiQForDate } from '@/lib/qcode/kyomeikai';

// POST body: { user_code: string, date?: "YYYY-MM-DD" }
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body.user_code || '').trim();
    if (!user_code)
      return NextResponse.json({ ok: false, error: 'user_code required' }, { status: 400 });

    const forDate =
      String(body.date || '').trim() ||
      new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);

    const result = await calcKyomeikaiQForDate(user_code, forDate);

    // q_code(JSONB) をそのまま格納（新規カラム不要）
    const q_code = {
      q: result.q,
      confidence: result.confidence,
      hint: result.hint,
      color_hex: result.color_hex,
      version: 'qmap.v0.3.2',
      by: 'sofia',
      meta: {
        source: 'kyomeikai-daily',
        ...result.meta,
      },
    };

    const { data, error } = await supabaseAdmin
      .from('q_code_logs')
      .insert([
        {
          user_code,
          source_type: 'event',
          intent: 'kyomeikai',
          q_code,
          // created_at はDBのDEFAULT NOW()を使う / or forDateの深夜時刻で固定したい場合は下記:
          // created_at: new Date(forDate + 'T23:55:00+09:00').toISOString(),
        },
      ])
      .select('id, created_at')
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
