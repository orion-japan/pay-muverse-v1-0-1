// /app/api/me/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET() {
  const supa = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!, // Service Role を使う
  );

  // ここは認証クッキーから uid を出す実装でもOK。暫定で1ユーザー固定なら user_code で検索
  const userCode = /* クッキーやセッションから取得 */ null;

  let row = null;
  if (userCode) {
    const { data } = await supa
      .from('users')
      .select('user_code, click_username, click_type, sofia_credit')
      .eq('user_code', userCode)
      .maybeSingle();
    row = data;
  }

  return NextResponse.json({
    id: row?.user_code ?? 'unknown',
    name: row?.click_username ?? 'user',
    user_type: row?.click_type ?? 'member',
    sofia_credit: Number(row?.sofia_credit ?? 0),
  });
}
