import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/visions/delete
 * body: { vision_id: string }
 * ハードデリート（ソフトデリートにしたい場合は patch で deleted_at を入れる運用に変更）
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

    const { data, error } = await supabase
      .from('visions')
      .delete()
      .eq('vision_id', vision_id)
      .eq('user_code', userCode)
      .select('vision_id')
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    if (!data) {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, vision_id: data.vision_id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
