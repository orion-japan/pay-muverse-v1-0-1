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
  if (post.media_urls && post.media_urls.length > 0) {
    const { error: storageError } = await supabase.storage
      .from('private-posts')
      .remove(post.media_urls);

    if (storageError) {
      console.warn('⚠️ ストレージ削除失敗:', storageError.message);
    }
  }

  // 🔥 投稿削除（これが必要！）
  const { error: deleteError } = await supabase.from('posts').delete().eq('post_id', post_id);

  if (deleteError) {
    return NextResponse.json({ error: deleteError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
