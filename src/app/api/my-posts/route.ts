import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  const { user_code } = await req.json();

  const { data: posts, error } = await supabase
    .from('posts')
    .select('*')
    .eq('user_code', user_code)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const postsWithSignedUrls = await Promise.all(
    posts.map(async (post) => {
      const signedUrls: string[] = [];

      if (post.media_urls && Array.isArray(post.media_urls)) {
        for (const path of post.media_urls) {
          const { data, error } = await supabase.storage
            .from('private-posts')
            .createSignedUrl(path, 60 * 60); // 1時間有効

          if (data?.signedUrl) {
            signedUrls.push(data.signedUrl);
          } else {
            console.warn(`⚠️ Signed URL生成失敗:`, error?.message || path);
            // 失敗したURLは追加しない
          }
        }
      }

      return {
        ...post,
        media_urls: signedUrls,
      };
    })
  );

  // null や media_urls が完全に空の投稿を除外（任意）
  const validPosts = postsWithSignedUrls.filter(p => p.media_urls.length > 0);

  return NextResponse.json(
    { posts: validPosts },
    {
      status: 200,
      headers: {
        'Cache-Control': 'no-store',
      },
    }
  );
}
