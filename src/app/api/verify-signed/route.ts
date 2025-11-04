import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // server-only
);

// 必要なら MU のドメインに絞ってください（例: https://muverse.jp）
function withCORS(json: any, status = 200) {
  return NextResponse.json(json, {
    status,
    headers: {
      'Access-Control-Allow-Origin': process.env.MU_ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function OPTIONS() {
  return withCORS({}, 200);
}

export async function POST(req: Request) {
  try {
    const { user_code } = await req.json();
    if (!user_code) return withCORS({ error: 'user_code required' }, 400);

    const { data, error } = await supabase
      .from('users')
      .select('click_username, click_type, sofia_credit')
      .eq('user_code', user_code)
      .maybeSingle();

    if (error) return withCORS({ error: error.message }, 500);
    if (!data) return withCORS({}, 404);

    return withCORS({
      click_username: data.click_username ?? null,
      click_type: data.click_type ?? null,
      sofia_credit:
        typeof data.sofia_credit === 'number' ? data.sofia_credit : Number(data.sofia_credit ?? 0),
    });
  } catch (e: any) {
    return withCORS({ error: e?.message ?? 'unknown' }, 500);
  }
}
