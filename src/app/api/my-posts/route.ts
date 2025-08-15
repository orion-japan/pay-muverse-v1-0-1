// app/api/my-posts/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  console.log('========== [my-posts] API開始 ==========');

  try {
    const { user_code } = await req.json();
    console.log('[my-posts] 📩 user_code:', user_code);

    if (!user_code) {
      return NextResponse.json({ error: 'user_codeが必要です' }, { status: 400 });
    }

    const { data: posts, error } = await supabaseServer
      .from('posts')
      .select('*')
      .eq('user_code', user_code)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[my-posts] ❌ 投稿取得失敗:', error);
      return NextResponse.json({ error: '取得失敗' }, { status: 500 });
    }

    console.log(`[my-posts] ✅ 投稿件数: ${posts.length}`);

    const postsWithSignedUrls = await Promise.all(
      posts.map(async (post, postIndex) => {
        console.log(`\n[post ${postIndex}] 🔍 処理開始:`, {
          post_id: post.post_id,
          content: post.content,
        });

        const mediaUrls = await Promise.all(
          (post.media_urls || []).map(async (path: string, i: number) => {
            console.log(`  [media ${i}] 🔗 パス: ${path}`);

            const { data, error } = await supabaseServer.storage
              .from('private-posts')
              .createSignedUrl(path, 60 * 60); // 1時間

            if (error || !data?.signedUrl) {
              console.warn(`  [media ${i}] ⚠️ Signed URL生成失敗`, error);
              return null;
            }

            console.log(`  [media ${i}] ✅ Signed URL生成成功`);
            return data.signedUrl;
          })
        );

        return {
          ...post,
          media_urls: mediaUrls.filter(Boolean),
        };
      })
    );

    console.log('[my-posts] ✅ 全投稿のSigned URL生成完了');

    return NextResponse.json({ posts: postsWithSignedUrls }, { status: 200 });
  } catch (error) {
    console.error('[my-posts] ❌ 投稿取得中にエラー:', error);
    return NextResponse.json({ error: '投稿取得中にエラー' }, { status: 500 });
  }
}
