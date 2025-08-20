// /app/api/reactions/toggle/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED = ['like', 'heart', 'smile', 'wow', 'share'] as const;
type AllowedReaction = (typeof ALLOWED)[number];

// local-only debug
const DEBUG = process.env.DEBUG_REACTIONS === '1';
const dlog = (...a: any[]) => DEBUG && console.log('[reactions/toggle]', ...a);

type Body = {
  post_id?: string;
  reaction?: AllowedReaction | string;
  user_code?: string;          // 押した人
  is_parent?: boolean;
  thread_id?: string | null;
};

function bad(message: string, extra: any = {}) {
  console.error('[reactions/toggle] 400:', message, extra);
  return NextResponse.json({ ok: false, message, ...extra }, { status: 400 });
}

export async function POST(req: NextRequest) {
  console.log('========== [/api/reactions/toggle] START ==========');

  let body: Body | null = null;
  try {
    body = await req.json();
  } catch {
    return bad('Invalid JSON body (Content-Type や JSON.stringify を確認してください)');
  }

  const { post_id, reaction, user_code, is_parent = false, thread_id = null } = body || {};
  if (!post_id) return bad('post_id is required');
  if (!user_code) return bad('user_code is required');
  if (!reaction) return bad('reaction is required');
  if (!ALLOWED.includes(reaction as AllowedReaction)) return bad('reaction is not allowed', { reaction });

  dlog('req body =', { post_id, reaction, user_code, is_parent, thread_id });

  try {
    // 投稿者（通知の宛先）
    const { data: post, error: postErr } = await supabase
      .from('posts')
      .select('user_code')
      .eq('post_id', post_id)
      .maybeSingle();
    if (postErr) return NextResponse.json({ ok: false, message: postErr.message }, { status: 500 });

    const target_user_code: string | null = post?.user_code ?? null;
    if (!target_user_code) {
      console.warn('[reactions/toggle] post.user_code is NULL for post_id', post_id);
      return NextResponse.json({ ok: false, message: 'post has no owner (user_code is NULL)' }, { status: 500 });
    }

    // 既存チェック（列選択せずに head+count）
    const { count, error: cntSelErr } = await supabase
      .from('reactions')
      .select('*', { head: true, count: 'exact' })
      .eq('post_id', post_id)
      .eq('user_code', user_code)
      .eq('reaction', reaction)
      .eq('is_parent', is_parent);
    if (cntSelErr) {
      console.error('[reactions/toggle] count select error', cntSelErr);
      return NextResponse.json({ ok: false, message: cntSelErr.message }, { status: 500 });
    }

    if ((count ?? 0) > 0) {
      // OFF：主キー名に依存せず、複合キーで削除
      const { error: delErr } = await supabase
        .from('reactions')
        .delete()
        .match({ post_id, user_code, reaction, is_parent });
      if (delErr) {
        console.error('[reactions/toggle] delete error', delErr);
        return NextResponse.json({ ok: false, message: delErr.message }, { status: 500 });
      }
      dlog('toggled OFF');
    } else {
      // ON
      const insertRow = { post_id, user_code, reaction, is_parent, thread_id };
      const { error: insErr } = await supabase.from('reactions').insert(insertRow);
      if (insErr) {
        console.error('[reactions/toggle] insert error', insErr, insertRow);
        return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 });
      }
      dlog('toggled ON');

      // 通知（自分自身は通知しない）— 互換カラムもセット
      if (user_code !== target_user_code) {
        const notif: Record<string, any> = {
          type: 'reaction',
          ref_post_id: post_id,
          post_id,                                 // 互換
          ref_reaction: reaction,
          actor_user_code: user_code,              // 行動者
          target_user_code,                        // 受け手（投稿者）
          recipient_user_code: target_user_code,   // 互換: NOT NULL対策
          user_code: target_user_code,             // 互換
          is_read: false,
        };
        dlog('will insert notification =', notif);
        const { error: notifErr } = await supabase.from('notifications').insert(notif);
        if (notifErr) console.warn('[reactions/toggle] notification insert warn:', notifErr.message);
      }
    }

    // like の数を posts に同期（任意）
    if (reaction === 'like') {
      const { count: likeCount } = await supabase
        .from('reactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post_id)
        .eq('reaction', 'like')
        .eq('is_parent', is_parent);
      await supabase.from('posts').update({ likes_count: likeCount ?? 0 }).eq('post_id', post_id);
    }

    // 最新カウント（UI用）
    const totals: Record<string, number> = {};
    for (const key of ALLOWED) {
      const { count: c } = await supabase
        .from('reactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post_id)
        .eq('reaction', key)
        .eq('is_parent', is_parent);
      totals[key] = c ?? 0;
    }

    return NextResponse.json({ ok: true, post_id, is_parent, totals });
  } catch (e: any) {
    console.error('[reactions/toggle] UNEXPECTED', e);
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 500 });
  } finally {
    console.log('========== [/api/reactions/toggle] END ==========');
  }
}
