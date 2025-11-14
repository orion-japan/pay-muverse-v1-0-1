// src/app/api/delete-post/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function DELETE(req: NextRequest) {
  const { post_id } = await req.json();

  console.log('[DELETE] post_id:', post_id);

  if (!post_id || typeof post_id !== 'string') {
    return NextResponse.json(
      { error: 'post_id is required' },
      { status: 400 },
    );
  }

  // ===== アルバム専用 ID（album://...）の場合 =====
  if (post_id.startsWith('album://')) {
    // 形式: album://<user_code>/<filename>
    const match = /^album:\/\/([^/]+)\/(.+)$/.exec(post_id);
    if (!match) {
      return NextResponse.json(
        { error: 'invalid album post_id format' },
        { status: 400 },
      );
    }

    const [, userCode, filename] = match;
    const storagePath = `${userCode}/${filename}`;

    console.log('[DELETE][album] storagePath:', storagePath);

    const { error: storageError } = await supabase.storage
      .from('private-posts')
      .remove([storagePath]);

    if (storageError) {
      console.warn('⚠️ アルバム画像削除失敗:', storageError.message);
      return NextResponse.json(
        { error: storageError.message },
        { status: 500 },
      );
    }

    // posts テーブルにはレコードを作っていない想定なので、DB 削除は行わない
    return NextResponse.json({ success: true, kind: 'album' });
  }

  // ===== 通常の投稿（UUID など） =====

  // 投稿取得
  const { data: post, error: fetchError } = await supabase
    .from('posts')
    .select('media_urls')
    .eq('post_id', post_id)
    .single();

  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  // ストレージから削除
  if (post?.media_urls && post.media_urls.length > 0) {
    const { error: storageError } = await supabase.storage
      .from('private-posts')
      .remove(post.media_urls);

    if (storageError) {
      console.warn('⚠️ ストレージ削除失敗:', storageError.message);
      // ここは警告のみで継続（必要なら 500 返してもよい）
    }
  }

  // 投稿削除
  const { error: deleteError } = await supabase
    .from('posts')
    .delete()
    .eq('post_id', post_id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, kind: 'post' });
}
