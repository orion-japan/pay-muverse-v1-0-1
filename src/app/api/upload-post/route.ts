// app/api/upload-post/route.ts

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  console.log('========== [upload-post] API開始 ==========');

  try {
    const body = await req.json();

    const {
      user_code,
      title,
      category,
      content,
      media_urls,
      tags,
      visibility,
    } = body;

    // ✅ バリデーション（titleは除外）
    if (!user_code || !media_urls || media_urls.length === 0) {
      console.error('[upload-post] ❌ 必須データ不足');
      return NextResponse.json(
        { error: 'Missing required fields.' },
        { status: 400 }
      );
    }

    // ✅ Supabase に挿入
    const { error } = await supabaseServer.from('posts').insert({
      user_code,
      title: title || null,              // ← titleは任意
      category: category || 'なし',
      content: content || '',
      media_urls,
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
