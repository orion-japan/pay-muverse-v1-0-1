// src/app/api/thread/reply/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { sendPushTo } from '@/lib/notify';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: NextRequest) {
  try {
    const {
      parent_post_id, // 親ポストID（thread_idでもOK）
      content,
      media_urls,
      author_user_code, // 返信した人
      author_name, // 返信者名（なくてもOK）
    } = await req.json();

    if (!parent_post_id || !author_user_code) {
      return NextResponse.json({ error: 'missing params' }, { status: 400 });
    }

    // 1) 子コメント保存（あなたのスキーマに合わせて調整）
    const { data: child, error: insErr } = await supabase
      .from('posts')
      .insert({
        content,
        media_urls,
        user_code: author_user_code,
        is_posted: false, // 子：未投稿扱いの運用なら
        is_thread: true,
        parent_board: parent_post_id,
        thread_id: parent_post_id,
        board_type: 'self',
      })
      .select('post_id, created_at')
      .maybeSingle();

    if (insErr) {
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }

    // 2) 親の作者を取得
    const { data: parent, error: pErr } = await supabase
      .from('posts')
      .select('user_code, title, content')
      .eq('post_id', parent_post_id)
      .maybeSingle();

    if (pErr) {
      return NextResponse.json({ error: pErr.message }, { status: 500 });
    }

    const parentAuthor = parent?.user_code;

    // 3) 自分で自分に返信したら通知しない
    if (parentAuthor && parentAuthor !== author_user_code) {
      // 4) 親作者へPush（consents.allow_r_talk と連動させるなら kind:'rtalk'）
      await sendPushTo(parentAuthor, {
        kind: 'rtalk',
        title: 'あなたのS Talkにコメントが届いたよ',
        body: author_name ? `${author_name} さんからの返信` : '新しい返信があります',
        url: `/thread/${parent_post_id}`,
        tag: `reply:${parent_post_id}`,
        renotify: true,
      });
    }

    return NextResponse.json({ ok: true, child });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
