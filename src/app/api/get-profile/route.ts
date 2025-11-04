// src/app/api/get-profile/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get('code');

  if (!code) {
    return NextResponse.json({ error: 'Missing user code' }, { status: 400 });
  }

  // ① プロフィール取得（従来どおり）
  const { data: profile, error: profileErr } = await supabaseServer
    .from('profiles')
    .select('*')
    .eq('user_code', code)
    .single();

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  // ② users から click_username を取得してマージ
  const { data: userRow, error: userErr } = await supabaseServer
    .from('users')
    .select('click_username')
    .eq('user_code', code)
    .single();

  // users に無くても API 自体は 200 を返し、値は null にしておく
  const click_username = !userErr && userRow ? (userRow.click_username ?? null) : null;

  return NextResponse.json({ ...profile, click_username }, { status: 200 });
}
