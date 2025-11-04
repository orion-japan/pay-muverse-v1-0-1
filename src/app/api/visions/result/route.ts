import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server only
);

/**
 * POST /api/visions/result
 * body: { vision_id: string, result_status?: '成功'|'中断'|'意図違い' | null }
 * - result_status を渡したら「結果に置く」（resulted_at=now, archived_at=NULL）
 * - null を渡したら「結果を解除」（result_* をすべて NULL）
 */
export async function POST(req: NextRequest) {
  try {
    const userCode =
      req.headers.get('x-user-code') || new URL(req.url).searchParams.get('user_code');
    if (!userCode) return NextResponse.json({ error: 'missing user_code' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { vision_id, result_status } = body as {
      vision_id?: string;
      result_status?: string | null;
    };
    if (!vision_id) return NextResponse.json({ error: 'missing vision_id' }, { status: 400 });

    const payload =
      result_status == null
        ? { result_status: null, resulted_at: null, archived_at: null }
        : { result_status, resulted_at: new Date().toISOString(), archived_at: null };

    const { error } = await supabase
      .from('visions')
      .update(payload)
      .eq('vision_id', vision_id)
      .eq('user_code', userCode);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[result]', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
