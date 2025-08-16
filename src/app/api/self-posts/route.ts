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

/* ---------------------- GET（anonでRLS適用） ---------------------- */
export async function GET(req: NextRequest) {
  console.log('========== [self-posts] GET 開始 ==========');
  try {
    const { searchParams } = new URL(req.url);
    const userCode = searchParams.get('userCode');
    const rawBoardType = searchParams.get('boardType') ?? searchParams.get('board_type');

    if (!userCode) {
      console.error('[❌ userCode が見つかりません]');
      return NextResponse.json({ error: 'userCode が必要です' }, { status: 400 });
    }

    // 未指定 or "null" or "" → null
    let normalizedBoardType: string | null = null;
    if (rawBoardType !== null) {
      const t = (rawBoardType ?? '').trim();
      normalizedBoardType = (t === '' || t.toLowerCase() === 'null') ? null : t;
    }

    console.log('[📥 GET 入力]', { userCode, rawBoardType, normalizedBoardType });

    let query = supabase
      .from('posts')
      .select('*')
      .eq('user_code', userCode)
      .order('created_at', { ascending: false });

    if (normalizedBoardType === null) {
      query = query.is('board_type', null);
    } else {
      query = query.eq('board_type', normalizedBoardType);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[❌ Supabaseエラー:GET]', { message: error.message, error });
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    console.log('[✅ 取得成功]', { count: data?.length ?? 0 });
    return NextResponse.json(data ?? []);
  } catch (e: any) {
    console.error('[💥 例外:GET]', e?.message || e);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

/* ---------------------- POST（service_roleでRLS回避） ---------------------- */
export async function POST(req: NextRequest) {
  console.log('========== [self-posts] POST 開始 ==========');
  try {
    // 環境変数チェック（※絶対にクライアントに露出させない）
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceKey) {
      console.error('[❌ 環境変数不足] NEXT_PUBLIC_SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が未設定');
      return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
    }

    // server-admin クライアント（RLSをバイパス）
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

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
      boardType, // alias
      is_posted = true,
    } = body as Record<string, any>;

    if (!user_code) {
      console.error('[❌ 必須欠落] user_code');
      return NextResponse.json({ error: 'user_code は必須です' }, { status: 400 });
    }

    // 画像なしOK（空配列許容）
    const normalizedMediaUrls: string[] = Array.isArray(media_urls)
      ? media_urls.filter((u) => typeof u === 'string' && u.trim().length > 0)
      : [];

    // board_type 正規化: 未指定 or "null" or "" → null
    let resolvedBoardType: string | null = null;
    const rawBT = typeof board_type === 'string' ? board_type
                  : typeof boardType === 'string' ? boardType
                  : undefined;
    if (typeof rawBT === 'string') {
      const t = rawBT.trim();
      resolvedBoardType = (t === '' || t.toLowerCase() === 'null') ? null : t;
    } else {
      resolvedBoardType = null;
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
      board_type: resolvedBoardType, // ← 'self' も null も可
      is_posted,
    };

    console.log('[🛠 正規化データ]', normalized);

    // admin で挿入（RLS適用外）
    const { data, error } = await admin
      .from('posts')
      .insert(normalized)
      .select('*')
      .single();

    if (error) {
      console.error('[❌ Supabaseエラー:POST(admin)]', { message: error.message, error });
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
