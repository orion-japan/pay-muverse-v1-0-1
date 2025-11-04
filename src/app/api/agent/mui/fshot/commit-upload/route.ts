export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function json(d: any, s = 200) {
  return new NextResponse(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => ({}));
    const session_id = String(b?.session_id || '');
    const user_code = String(b?.user_code || 'DEMO');
    const file_path = String(b?.file_path || '');
    const width = Number(b?.width ?? 0) || null;
    const height = Number(b?.height ?? 0) || null;

    if (!session_id || !file_path)
      return json({ ok: false, error: 'missing session_id/file_path' }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    // images 末尾に push
    const { error } = await sb
      .rpc('jsonb_array_append_obj', {
        tname: 'mu_fshot_sessions',
        id_col: 'id',
        id_val: session_id,
        col: 'images',
        obj: { path: file_path, w: width, h: height, at: new Date().toISOString() },
        set_updated: true,
      } as any)
      .single();

    // ↑ 汎用RPCが無い場合は UPDATE で置換
    if (error) {
      // フォールバック：現在値を取得して上書き
      const { data: row, error: e1 } = await sb
        .from('mu_fshot_sessions')
        .select('images')
        .eq('id', session_id)
        .single();
      if (e1) return json({ ok: false, error: e1.message }, 500);
      const arr: any[] = Array.isArray(row?.images) ? row.images : [];
      arr.push({ path: file_path, w: width, h: height, at: new Date().toISOString() });
      const { error: e2 } = await sb
        .from('mu_fshot_sessions')
        .update({ images: arr, updated_at: new Date().toISOString() })
        .eq('id', session_id);
      if (e2) return json({ ok: false, error: e2.message }, 500);
    }
    return json({ ok: true });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
}
