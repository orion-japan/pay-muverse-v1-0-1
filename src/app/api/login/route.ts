// src/app/api/login/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function POST(req: NextRequest) {
  try {
    // ✅ JSONボディを取得
    const { email, password } = await req.json();

    // ✅ Supabase でユーザー認証確認
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .eq('click_email', email)
      .eq('Password', password)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { success: false, message: 'メールまたはパスワードが間違っています' },
        { status: 401 }
      );
    }

    // ✅ 認証成功レスポンス
    return NextResponse.json({ success: true, user: data }, { status: 200 });

  } catch (err) {
    console.error('❌ login API Error:', err);
    return NextResponse.json(
      { success: false, message: 'サーバーエラーが発生しました' },
      { status: 500 }
    );
  }
}
