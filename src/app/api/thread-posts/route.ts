// src/app/api/thread-posts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export const dynamic = 'force-dynamic';

// v_posts_jst の受け取り型
type Row = {
  post_id: string;
  user_code: string | null;
  content: string | null;
  created_at: string; // ← created_at_jst を created_at 名で受ける
  thread_id: string | null;
  parent_post_id: string | null;
  board_type: string | null;
  is_thread: boolean | null;
  media_urls: string[] | null;
  tags: string[] | null;
  visibility: 'public' | 'private' | null;
};

type Enriched = Row & {
  click_username: string | null;
  avatar_url: string | null;
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const threadId = searchParams.get('threadId');
  if (!threadId) return NextResponse.json({ error: 'Missing threadId' }, { status: 400 });

  try {
    let original: Row | null = null;

    // 1) 親（is_thread 優先）
    const { data: withFlag, error: ofErr } = await supabase
      .from('v_posts_jst') // ★ ジェネリクス外す
      .select(
        'post_id,user_code,content,created_at:created_at_jst,thread_id,parent_post_id,board_type,is_thread,media_urls,tags,visibility',
      )
      .eq('post_id', threadId)
      .eq('is_thread', true)
      .maybeSingle();

    if (ofErr) console.warn('[thread-posts] is_thread check warn:', ofErr.message);
    if (withFlag) original = withFlag as Row;

    // 2) fallback: is_thread = false でも検索
    if (!original) {
      const { data, error } = await supabase
        .from('v_posts_jst') // ★ ジェネリクス外す
        .select(
          'post_id,user_code,content,created_at:created_at_jst,thread_id,parent_post_id,board_type,is_thread,media_urls,tags,visibility',
        )
        .eq('post_id', threadId)
        .single();

      if (error || !data) {
        console.error('[thread-posts] original not found:', error);
        return NextResponse.json({ error: 'Original post not found' }, { status: 404 });
      }
      original = data as Row;
    }

    // 3) 返信（thread_id → parent_post_id）
    let replies: Row[] = [];

    const { data: byThreadId, error: e1 } = await supabase
      .from('v_posts_jst') // ★ ジェネリクス外す
      .select(
        'post_id,user_code,content,created_at:created_at_jst,thread_id,parent_post_id,board_type,is_thread,media_urls,tags,visibility',
      )
      .eq('thread_id', threadId)
      .order('created_at_jst', { ascending: true });

    if (!e1 && Array.isArray(byThreadId) && byThreadId.length) {
      replies = byThreadId as Row[];
    } else {
      const { data: byParent, error: e2 } = await supabase
        .from('v_posts_jst') // ★ ジェネリクス外す
        .select(
          'post_id,user_code,content,created_at:created_at_jst,thread_id,parent_post_id,board_type,is_thread,media_urls,tags,visibility',
        )
        .eq('parent_post_id', threadId)
        .order('created_at_jst', { ascending: true });

      if (!e2 && Array.isArray(byParent)) replies = byParent as Row[];
    }

    // 4) 親＋子をマージ（重複排除）
    const map = new Map<string, Row>();
    map.set(original.post_id, original);
    for (const r of replies) map.set(r.post_id, r);
    const all = Array.from(map.values());

    // 5) profiles で名前/アイコンを付与
    const codes = Array.from(new Set(all.map((p) => p?.user_code).filter(Boolean) as string[]));
    const nameMap = new Map<string, string | null>();
    const avatarMap = new Map<string, string | null>();

    if (codes.length > 0) {
      const { data: profilesRows, error: pErr } = await supabase
        .from('profiles')
        .select('user_code,name,avatar_url')
        .in('user_code', codes);

      if (pErr) {
        console.error('[thread-posts] profiles fetch error:', pErr);
      } else {
        profilesRows?.forEach((p: any) => {
          nameMap.set(p.user_code, p.name ?? null);
          avatarMap.set(p.user_code, p.avatar_url ?? null);
        });
      }
    }

    const enriched: Enriched[] = all.map((p) => ({
      ...p,
      click_username: (p.user_code && nameMap.get(p.user_code)) ?? null,
      avatar_url: (p.user_code && avatarMap.get(p.user_code)) ?? null,
    }));

    // 6) キャッシュ禁止で返す（created_at は JST のまま）
    return NextResponse.json(enriched, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e: any) {
    console.error('[thread-posts] unexpected:', e?.message ?? e);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
