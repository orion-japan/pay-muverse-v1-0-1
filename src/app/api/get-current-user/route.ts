import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  console.log('========== [get-current-user] API開始 ==========');

  try {
    const {
      data: { user },
      error,
    } = await supabaseServer.auth.getUser();

    if (error || !user) {
      console.error('[get-current-user] ❌ ユーザー取得失敗', error);
      return NextResponse.json({ error: 'ユーザーが見つかりません' }, { status: 400 });
    }

    console.log('[get-current-user] ✅ 取得成功:', user.id);

    return NextResponse.json({ user_code: user.id }, { status: 200 });
  } catch (err) {
    console.error('[get-current-user] ❌ エラー', err);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
