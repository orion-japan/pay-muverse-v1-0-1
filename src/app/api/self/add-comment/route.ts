import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  console.log('========== [add-comment] API 開始 ==========');

  try {
    const body = await req.json();
    const {
      thread_id,
      user_code,
      content,
      board_type,
      media_urls = [],
    } = body;

    // 必須項目チェック
    if (!thread_id || !user_code || !content) {
      console.error('[❌ 必須データ不足]');
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Supabase 環境変数が未設定です' }, { status: 500 });
    }

    const supabase = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const { data, error } = await supabase
      .from('posts')
      .insert({
        thread_id,
        user_code,
        content,
        board_type: board_type ?? null,
        media_urls: Array.isArray(media_urls) ? media_urls : [],
        is_posted: false, // 子投稿
        is_thread: false,
      })
      .select('*')
      .single();

    if (error) {
      console.error('[❌ Supabase挿入エラー]', error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[✅ 子投稿 成功]', data);
    return NextResponse.json(data, { status: 201 });

  } catch (err: any) {
    console.error('[❌ 例外エラー]', err.message || err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
