import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/visions/archive
 * body: { vision_id: string }
 * - 手動で履歴へ移管（archived_at=now）
 */
export async function POST(req: NextRequest) {
  try {
    const userCode = req.headers.get('x-user-code') || new URL(req.url).searchParams.get('user_code');
    if (!userCode) return NextResponse.json({ error: 'missing user_code' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const { vision_id } = body as { vision_id?: string };
    if (!vision_id) return NextResponse.json({ error: 'missing vision_id' }, { status: 400 });

    const { error } = await supabase
      .from('visions')
      .update({ archived_at: new Date().toISOString() })
      .eq('vision_id', vision_id)
      .eq('user_code', userCode);

    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[archive]', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
