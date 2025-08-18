// /api/board-posts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';
import { createClient } from '@supabase/supabase-js';
import { copyImageToPublic } from '@/lib/copyImageToPublic';

export const dynamic = 'force-dynamic';

type PostInsert = {
  user_code: string;
  title?: string | null;
  content?: string | null;
  category?: string | null;
  tags?: string[] | null;
  media_urls: string[];
  board_type?: string | null;
  is_posted?: boolean;
};

/* ---------------------- GET（公開Board投稿一覧） ---------------------- */
export async function GET(req: NextRequest) {
  console.log('========== [board-posts] GET 開始 ==========');

  try {
    const { searchParams } = new URL(req.url);
    const boardType = searchParams.get('boardType') ?? 'board';

    const { data: posts, error: postErr } = await supabase
      .from('posts')
      .select(
        'post_id, title, content, created_at, board_type, user_code, is_thread, media_urls, tags, visibility'
      )
      .eq('board_type', boardType)
      .eq('is_posted', true)
      .eq('is_thread', true)
      .eq('visibility', 'public')
      .order('created_at', { ascending: false });

    if (postErr) {
      console.error('[❌ GET] Supabaseエラー(posts):', postErr.message);
      return NextResponse.json({ error: postErr.message }, { status: 500 });
    }

    // プロフィール取得
    const codes = Array.from(new Set(posts?.map((p) => p.user_code))).filter(Boolean);
    const { data: profs } = await supabase
      .from('profiles')
      .select('user_code,name,avatar_url')
      .in('user_code', codes as string[]);

    const profileMap: Record<string, { name: string | null; avatar_url: string | null }> = {};
    (profs ?? []).forEach((r) => {
      profileMap[r.user_code] = {
        name: r.name ?? null,
        avatar_url: r.avatar_url ?? null,
      };
    });

    // マージ
    const merged = (posts ?? []).map((p) => {
      const prof = profileMap[p.user_code];
      return {
        ...p,
        author: prof?.name ?? p.user_code,
        avatar_url: prof?.avatar_url ?? null,
      };
    });

    return NextResponse.json(merged);
  } catch (err: any) {
    console.error('[❌ GET] 予期せぬエラー:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

/* ---------------------- POST（Board投稿：private画像をpublicにコピーして保存） ---------------------- */
export async function POST(req: NextRequest) {
  console.log('========== [board-posts] POST 開始 ==========');

  try {
    const body: PostInsert = await req.json();
    const { user_code, media_urls = [], title, content, category, tags } = body;

    if (!user_code) {
      return NextResponse.json({ error: 'user_code が必要です' }, { status: 400 });
    }

    // Supabase Admin client
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    // Private 画像を Public にコピー
    const publicUrls: string[] = [];
    for (const url of media_urls) {
      try {
        const copied = await copyImageToPublic(url, user_code);
        if (copied) publicUrls.push(copied);
      } catch (err) {
        console.error('[❌ 画像コピー失敗]', url, err);
      }
    }

    if (publicUrls.length === 0) {
      return NextResponse.json({ error: '画像コピーに失敗しました' }, { status: 500 });
    }

    const insertData = {
      user_code,
      title: title ?? null,
      content: content ?? null,
      category: category ?? null,
      tags: Array.isArray(tags) ? tags : null,
      media_urls: publicUrls,
      visibility: 'public',
      board_type: 'board',
      is_posted: true,
      is_thread: true,
    };

    const { data, error } = await admin.from('posts').insert(insertData).select().single();

    if (error) {
      console.error('[❌ supabase insert エラー]', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[✅ Board投稿成功]', data);
    return NextResponse.json(data, { status: 201 });
  } catch (err: any) {
    console.error('[❌ POSTエラー]', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
