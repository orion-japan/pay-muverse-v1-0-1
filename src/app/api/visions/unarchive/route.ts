import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/visions/unarchive
 * body: { vision_id: string }
 * 履歴 → 実践へ戻す（履歴系の日時をクリア）
 */
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userCode =
      req.headers.get('x-user-code') ||
      url.searchParams.get('user_code') || '';

    if (!userCode) {
      return NextResponse.json({ error: 'missing user_code' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const vision_id = String(body?.vision_id ?? '').trim();
    if (!vision_id) {
      return NextResponse.json({ error: 'missing vision_id' }, { status: 400 });
    }

    const patch = {
      moved_to_history_at: null,
      archived_at: null,
      updated_at: new Date().toISOString(),
      // 必要なら status も元に戻す（例: '検討中'）
      // status: '検討中' as const,
    };

    const { data, error, status } = await supabase
      .from('visions')
      .update(patch)
      .eq('vision_id', vision_id)
      .eq('user_code', userCode)
      .select('vision_id, moved_to_history_at, archived_at')
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
