// src/app/api/friends/list/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export async function GET(req: NextRequest) {
  const me = req.headers.get('x-user-code') ?? '';

  const { data, error } = await supabase
    .from('friendships')
    .select('*')
    .or(`user_code_a.eq.${me},user_code_b.eq.${me}`);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 相手コードを抽出
  const friends = (data ?? []).map((r) => (r.user_code_a === me ? r.user_code_b : r.user_code_a));
  return NextResponse.json({ ok: true, friends });
}
