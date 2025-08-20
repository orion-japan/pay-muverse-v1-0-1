import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/** GET /api/comments?post_id=xxxx
 *  公開コメントを古い順で返す
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const postId = searchParams.get('post_id');
    if (!postId) {
      return NextResponse.json({ error: 'post_id is required' }, { status: 400 });
    }

    const { data, error } = await supabaseServer
      .from('comments') // ← テーブル名に合わせてください
      .select('*')
      .eq('post_id', postId)
      .eq('visibility', 'public')
      .order('created_at', { ascending: true });

    if (error) throw error;
    return NextResponse.json({ comments: data ?? [] }, { status: 200 });
  } catch (e: any) {
    console.error('[comments][GET] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

/** POST /api/comments
 *  body: { post_id, user_code, content }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { post_id, user_code, content } = body || {};
    if (!post_id || !user_code || !content?.trim()) {
      return NextResponse.json({ error: 'post_id, user_code, content are required' }, { status: 400 });
    }

    const insertData = {
      post_id,
      user_code,
      content: String(content).trim(),
      visibility: 'public',   // 公開固定
    };

    const { data, error } = await supabaseServer
      .from('comments') // ← テーブル名に合わせてください
      .insert(insertData)
      .select()
      .single();

    if (error) throw error;

    // ついでに posts.comments_count をインクリメントしたい場合（任意）
    // await supabaseServer.rpc('inc_post_comments_count', { target_post_id: post_id });

    return NextResponse.json({ comment: data }, { status: 201 });
  } catch (e: any) {
    console.error('[comments][POST] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
