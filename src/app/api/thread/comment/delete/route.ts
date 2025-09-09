import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    const me = (auth as any)?.userCode ?? (auth as any)?.user_code;
    if (!me) return json({ ok: false, error: 'unauthorized' }, 401);

    const { target, id, cascade } = await req.json().catch(() => ({}));
    if (!id || !target) return json({ ok: false, error: 'bad_request' }, 400);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (target === 'post') {
      // 所有者チェック
      const { data: post, error: getErr } = await admin
        .from('posts')
        .select('post_id,user_code')
        .eq('post_id', id)
        .single();
      if (getErr) return json({ ok: false, error: getErr.message }, 500);
      if (!post || String(post.user_code) !== String(me)) return json({ ok: false, error: 'forbidden' }, 403);

      if (cascade) {
        // 親：子ポストIDを取得
        const { data: children, error: chErr } = await admin
          .from('posts')
          .select('post_id')
          .eq('thread_id', id);
        if (chErr) return json({ ok: false, error: chErr.message }, 500);

        const childIds = (children ?? []).map((r: any) => r.post_id);
        const allPostIds = [id, ...childIds];

        // 先にコメントを削除 → ポスト削除
        if (allPostIds.length) {
          const { error: cDelErr } = await admin.from('comments').delete().in('post_id', allPostIds);
          if (cDelErr) return json({ ok: false, error: cDelErr.message }, 500);
        }
        if (childIds.length) {
          const { error: pChildDelErr } = await admin.from('posts').delete().in('post_id', childIds);
          if (pChildDelErr) return json({ ok: false, error: pChildDelErr.message }, 500);
        }
        const { error: pParentDelErr } = await admin.from('posts').delete().eq('post_id', id);
        if (pParentDelErr) return json({ ok: false, error: pParentDelErr.message }, 500);

        return json({ ok: true });
      } else {
        // 子：そのポストのコメント→ポストの順で物理削除
        const { error: cDelErr } = await admin.from('comments').delete().eq('post_id', id);
        if (cDelErr) return json({ ok: false, error: cDelErr.message }, 500);

        const { error: pDelErr } = await admin
          .from('posts')
          .delete()
          .eq('post_id', id)
          .eq('user_code', me);
        if (pDelErr) return json({ ok: false, error: pDelErr.message }, 500);

        return json({ ok: true });
      }
    }

    if (target === 'comment') {
      // コメント：本人のものだけ物理削除
      const { data: c, error: getErr } = await admin
        .from('comments')
        .select('comment_id,user_code')
        .eq('comment_id', id)
        .single();
      if (getErr) return json({ ok: false, error: getErr.message }, 500);
      if (!c || String(c.user_code) !== String(me)) return json({ ok: false, error: 'forbidden' }, 403);

      const { error: delErr } = await admin.from('comments').delete().eq('comment_id', id).eq('user_code', me);
      if (delErr) return json({ ok: false, error: delErr.message }, 500);

      return json({ ok: true });
    }

    return json({ ok: false, error: 'unsupported_target' }, 400);
  } catch (e: any) {
    return json({ ok: false, error: e?.message || 'internal_error' }, 500);
  }
}
