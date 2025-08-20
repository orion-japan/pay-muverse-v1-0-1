// /app/api/reactions/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * GET /api/reactions/history?user_code=XXXX&scope=received|given&limit=20
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code');
  const scope = (searchParams.get('scope') || 'received') as 'received' | 'given';
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10) || 20, 100);

  if (!user_code) {
    return NextResponse.json({ ok: false, message: 'user_code is required' }, { status: 400 });
  }

  try {
    // received: 自分の投稿に付いたリアクション
    // given    : 自分が付けたリアクション
    let q = supabase
      .from('reactions')
      .select('reaction_id, post_id, user_code, reaction, is_parent, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (scope === 'received') {
      // posts.user_code = 自分
      const { data: rows, error } = await q.in(
        'post_id',
        (
          await supabase.from('posts').select('post_id').eq('user_code', user_code)
        ).data?.map((r) => r.post_id) || ['00000000-0000-0000-0000-000000000000'] // 空防止
      );
      if (error) throw error;
      return NextResponse.json({ ok: true, items: rows ?? [] });
    } else {
      const { data: rows, error } = await q.eq('user_code', user_code);
      if (error) throw error;
      return NextResponse.json({ ok: true, items: rows ?? [] });
    }
  } catch (e: any) {
    console.error('[reactions/history] error', e);
    return NextResponse.json({ ok: false, message: e?.message || 'error' }, { status: 500 });
  }
}
