import { NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  console.log('========== [upload-post] API開始 ==========');

  try {
    const body = await req.json();

    const { user_code, title, category, content, media_urls, tags, visibility } = body;

    // ✅ バリデーション（user_code のみ必須）
    if (!user_code) {
      console.error('[upload-post] ❌ user_codeが不足しています');
      return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 });
    }

    const { error } = await supabaseServer.from('posts').insert({
      user_code,
      title: title || null,
      category: category || 'なし',
      content: content || '',
      media_urls: media_urls || [],
      tags: tags || [],
      visibility: visibility || 'public',
    });

    if (error) {
      console.error('[upload-post] ❌ 投稿保存エラー', error);
      return NextResponse.json({ error: '投稿保存失敗' }, { status: 500 });
    }

    console.log('[upload-post] ✅ 投稿保存成功');
    return NextResponse.json({ message: '投稿保存成功' }, { status: 200 });
  } catch (err) {
    console.error('[upload-post] ❌ 処理エラー', err);
    return NextResponse.json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
