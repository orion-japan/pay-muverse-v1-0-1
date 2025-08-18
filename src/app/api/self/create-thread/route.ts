import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  console.log('========== [create-thread] API開始 ==========');
  try {
    const body = await req.json();
    const {
      user_code,
      title = null,
      content = null,
      category = null,
      tags,
      media_urls,
      visibility = 'public',
      board_type = 'self',
    } = body ?? {};

    if (!user_code) {
      return NextResponse.json({ error: 'user_code is required' }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const safeMedia: string[] = Array.isArray(media_urls) ? media_urls.filter(Boolean) : [];
    const safeTags: string[] | null =
      Array.isArray(tags) ? tags :
      (typeof tags === 'string' && tags.trim())
        ? tags.split(',').map(t => t.trim()).filter(Boolean)
        : null;

    // ✅ visibility を安全に判定
    const allowedVisibility = ['public', 'private', 'friends'] as const;
    const safeVisibility = allowedVisibility.includes(visibility)
      ? visibility
      : 'public';

    // 1) 親投稿を作成（is_thread = true / is_posted = true）
    const { data: inserted, error: insertErr } = await admin
      .from('posts')
      .insert({
        user_code,
        title,
        content,
        category,
        tags: safeTags,
        media_urls: safeMedia,
        visibility: safeVisibility, // ✅ ← ここ
        board_type,
        is_posted: true,
        is_thread: true,
      })
      .select('post_id,is_thread,is_posted')
      .single();
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 500 });

    // 2) 自分自身の post_id を thread_id に設定
    const postId = inserted.post_id as string;
    const { error: updateErr } = await admin
      .from('posts')
      .update({ thread_id: postId })
      .eq('post_id', postId);
    if (updateErr) console.warn('[thread_id 更新エラー]', updateErr);

    return NextResponse.json({ threadId: postId, post_id: postId }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Unknown error' }, { status: 500 });
  }
}
