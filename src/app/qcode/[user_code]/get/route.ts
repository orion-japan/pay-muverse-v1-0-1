// src/app/qcode/[q_code]/get/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function extractQCode(url: string): string | null {
  const { pathname } = new URL(url);
  const m = pathname.match(/\/qcode\/([^/]+)\/get\/?$/);
  return m?.[1] ?? null;
}

export async function GET(req: Request) {
  const q_code = extractQCode(req.url);
  if (!q_code) {
    return NextResponse.json({ ok: false, message: 'q_code required' }, { status: 400 });
  }

  // profiles から公開情報を返す（必要に応じて項目調整）
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, avatar_url, q_code_current, recent_q_codes')
    .eq('q_code_current', q_code)
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, message: 'not found' }, { status: 404 });

  return NextResponse.json({ ok: true, profile: data });
}
