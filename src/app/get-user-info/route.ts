// src/app/api/get-user-info/route.ts
import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: Request) {
  try {
    const { user_code } = await req.json();
    if (!user_code) {
      return NextResponse.json({ error: 'user_code is required' }, { status: 400 });
    }

    // ✅ user_code で Supabase を検索
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('user_code', user_code)
      .single();

    if (error) {
      console.error('❌ Supabase error:', error);
      return NextResponse.json({ error: 'ユーザー情報の取得に失敗しました' }, { status: 500 });
    }

    return NextResponse.json({ user: data }, { status: 200 });
  } catch (e) {
    console.error('❌ API error:', e);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
