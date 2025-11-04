import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase クライアント（Service Role Key を使用）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function PATCH(req: NextRequest) {
  const { post_id, content, tags } = await req.json();

  console.log('[update-post]', { post_id, content, tags });

  // まず元の投稿を取得して media_urls を確保
  const { data: originalData, error: getError } = await supabase
    .from('posts')
    .select('*')
    .eq('post_id', post_id)
    .single();

  if (getError || !originalData) {
    console.error('❌ 投稿取得失敗', getError?.message);
    return NextResponse.json({ error: '投稿が見つかりません' }, { status: 404 });
  }

  const { media_urls } = originalData;

  // 投稿を更新
  const { data: updatedData, error: updateError } = await supabase
    .from('posts')
    .update({ content, tags })
    .eq('post_id', post_id)
    .select()
    .single();

  if (updateError || !updatedData) {
    console.error('❌ 更新失敗', updateError?.message);
    return NextResponse.json({ error: '更新に失敗しました' }, { status: 500 });
  }

  // Signed URL を再生成
  const signedUrls: string[] = [];

  if (media_urls && Array.isArray(media_urls)) {
    for (const path of media_urls) {
      const { data: signedData, error: signedError } = await supabase.storage
        .from('private-posts')
        .createSignedUrl(path, 60 * 60); // 1時間有効

      if (signedData?.signedUrl) {
        signedUrls.push(signedData.signedUrl);
      } else {
        signedUrls.push('');
        console.warn('⚠️ Signed URL 生成失敗:', signedError?.message || path);
      }
    }
  }

  // クライアントへ返す
  return NextResponse.json({
    ...updatedData,
    media_urls: signedUrls, // signed URL を渡す
  });
}
