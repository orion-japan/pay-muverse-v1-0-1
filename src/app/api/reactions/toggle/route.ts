import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 許可するリアクションの種類
const ALLOWED = new Set(['like', 'heart', 'smile', 'wow', 'share']);

type Body = {
  post_id?: string;
  reaction?: string;
  user_code?: string;
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

  // バリデーション
  if (!post_id) return bad('post_id is required');
  if (!user_code) return bad('user_code is required');
  if (!reaction) return bad('reaction is required');
  if (!ALLOWED.has(reaction)) return bad('reaction is not allowed', { reaction });

  console.log('[reactions/toggle] ▶ body', { post_id, reaction, user_code, is_parent, thread_id });

  // reactions テーブル前提:
  // columns: id(uuid) / post_id(uuid) / user_code(text) / reaction(text) / is_parent(bool) / thread_id(uuid|null) / created_at
  // 既存に合わせてカラム名を調整してください
  try {
    // 既に押しているか確認
    const { data: existing, error: selErr } = await supabase
      .from('reactions')
      .select('id')
      .eq('post_id', post_id)
      .eq('user_code', user_code)
      .eq('reaction', reaction)
      .eq('is_parent', is_parent)
      .maybeSingle();

    if (selErr) {
      console.error('[reactions/toggle] select error', selErr);
      return NextResponse.json({ ok: false, message: selErr.message }, { status: 500 });
    }

    if (existing) {
      // 付いていれば削除（トグルOFF）
      const { error: delErr } = await supabase
        .from('reactions')
        .delete()
        .eq('id', existing.id);

      if (delErr) {
        console.error('[reactions/toggle] delete error', delErr);
        return NextResponse.json({ ok: false, message: delErr.message }, { status: 500 });
      }
      console.log('[reactions/toggle] ✅ toggled OFF');
    } else {
      // 無ければ追加（トグルON）
      const insert = {
        post_id,
        user_code,
        reaction,
        is_parent,
        thread_id,
      };
      const { error: insErr } = await supabase.from('reactions').insert(insert);
      if (insErr) {
        console.error('[reactions/toggle] insert error', insErr, insert);
        return NextResponse.json({ ok: false, message: insErr.message }, { status: 500 });
      }
      console.log('[reactions/toggle] ✅ toggled ON');
    }

    // 任意: posts.likes_count を再計算（like のみ）
    if (reaction === 'like') {
      const { count, error: cntErr } = await supabase
        .from('reactions')
        .select('*', { count: 'exact', head: true })
        .eq('post_id', post_id)
        .eq('reaction', 'like')
        .eq('is_parent', is_parent);

      if (!cntErr) {
        await supabase.from('posts').update({ likes_count: count ?? 0 }).eq('post_id', post_id);
      }
    }

    // 最新カウントを返す（UI更新用）
    const { data: totals, error: aggErr } = await supabase
      .rpc('count_reactions_by_post', { p_post_id: post_id, p_is_parent: is_parent })
      .select()
      .maybeSingle();
    // ↑ もし RPC をまだ作っていなければ、この部分は省略 or 個別に count() してください

    return NextResponse.json({ ok: true, post_id, is_parent, totals: totals ?? null });
  } catch (e: any) {
    console.error('[reactions/toggle] UNEXPECTED', e);
    return NextResponse.json({ ok: false, message: 'Unexpected error' }, { status: 500 });
  } finally {
    console.log('========== [/api/reactions/toggle] END ==========');
  }
}
