import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type PostInsert = {
  user_code: string;
  title?: string | null;
  content?: string | null;
  category?: string | null;
  tags?: string[] | null;
  media_urls: string[];
  visibility?: 'public' | 'private';
  board_type: string | null;
  is_posted?: boolean;
};

/* ---------------------- GET（親だけ返す） ---------------------- */
/* ---------------------- GET（全ユーザー公開スレッドを返す） ---------------------- */
export async function GET(req: NextRequest) {
  console.log('========== [self-posts] GET 開始 ==========');

  try {
    const { searchParams } = new URL(req.url);
    const rawBoardType = searchParams.get('boardType') ?? searchParams.get('board_type');

    // board_typeの正規化（未指定なら "self"）
    const boardType = (rawBoardType ?? 'self').toString();

    console.log('[🔍 GET] フィルター条件:', {
      is_posted: true,
      is_thread: true,
      visibility: 'public',
      board_type: boardType,
    });

    // 1) posts 取得（userCode では絞らない）
    const { data: posts, error: postErr } = await supabase
      .from('posts')
      .select(
        [
          'post_id',
          'content',
          'created_at',
          'board_type',
          'user_code',
          'is_thread',
          'thread_id',
          'media_urls',
          'tags',
          'visibility',
        ].join(',')
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

    const postList = posts ?? [];
    console.log(`[✅ GET] posts 取得件数: ${postList.length}`);

    if (postList.length === 0) {
      return NextResponse.json([]);
    }

    // 2) profiles をまとめて取得
    const codes = Array.from(new Set(postList.map((p: any) => p.user_code))).filter(Boolean);

    const { data: profs, error: profErr } = await supabase
      .from('profiles')
      .select('user_code,name,avatar_url')
      .in('user_code', codes as string[]);

    if (profErr) {
      console.warn('[⚠️ GET] profiles 取得エラー（継続）:', profErr.message);
    }

    const profileMap: Record<string, { name: string | null; avatar_url: string | null }> = {};
    (profs ?? []).forEach((r: any) => {
      profileMap[r.user_code] = {
        name: r.name ?? null,
        avatar_url: r.avatar_url ?? null,
      };
    });

    // 3) マージ
    const merged = postList.map((p: any) => {
      const prof = profileMap[p.user_code];
      return {
        ...p,
        author: prof?.name ?? p.user_code,
        avatar_url: prof?.avatar_url ?? null,
        profiles: {
          name: prof?.name ?? null,
          avatar_url: prof?.avatar_url ?? null,
        },
      };
    });

    return NextResponse.json(merged);
  } catch (err: any) {
    console.error('[❌ GET] 予期しないエラー:', err?.message || err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}


/* ---------------------- POST（既存のまま：親の新規作成） ---------------------- */
export async function POST(req: NextRequest) {
  console.log('========== [self-posts] POST 開始 ==========');
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      console.error('[❌ 環境変数不足]');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false },
    });

    const contentType = req.headers.get('content-type');
    if (!contentType?.includes('application/json')) {
      console.warn('[⚠️ Content-Type 不正または未設定]', contentType);
    }

    const body = await req.json().catch(() => null);
    console.log('[📥 受信ボディ]', body);

    if (!body || typeof body !== 'object') {
      console.error('[❌ JSON ボディなし]');
      return NextResponse.json({ error: 'JSON ボディが必要です' }, { status: 400 });
    }

    const {
      user_code,
      title = null,
      content = null,
      category = null,
      tags,
      media_urls,
      visibility = 'public',
      board_type,
      boardType,
      is_posted = true,
    } = body as Record<string, any>;

    if (!user_code) {
      console.error('[❌ 必須欠落] user_code');
      return NextResponse.json({ error: 'user_code は必須です' }, { status: 400 });
    }

    const normalizedMediaUrls: string[] = Array.isArray(media_urls)
      ? media_urls.filter((u) => typeof u === 'string' && u.trim().length > 0)
      : [];

    let resolvedBoardType: string | null = null;
    const rawBT =
      typeof board_type === 'string'
        ? board_type
        : typeof boardType === 'string'
        ? boardType
        : undefined;
    if (typeof rawBT === 'string') {
      const t = rawBT.trim();
      resolvedBoardType = t === '' || t.toLowerCase() === 'null' ? null : t;
    }

    const normalized: PostInsert = {
      user_code,
      title,
      content,
      category,
      tags: Array.isArray(tags)
        ? tags
        : typeof tags === 'string' && tags.trim()
        ? tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : null,
      media_urls: normalizedMediaUrls,
      visibility: visibility === 'private' ? 'private' : 'public',
      board_type: resolvedBoardType,
      is_posted,
    };

    console.log('[🛠 正規化データ]', normalized);

    const { data, error } = await admin
      .from('posts')
      .insert({ ...normalized, is_thread: true })
      .select('*')
      .single();

    if (error) {
      console.error('[❌ Supabaseエラー:POST(admin)]', {
        message: error.message,
        error,
      });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[✅ 挿入成功]', {
      post_id: (data as any)?.post_id ?? (data as any)?.id,
      board_type: (data as any)?.board_type,
      media_urls: (data as any)?.media_urls,
    });

    return NextResponse.json(data, { status: 201 });
  } catch (e: any) {
    console.error('[💥 例外:POST]', e?.message || e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
