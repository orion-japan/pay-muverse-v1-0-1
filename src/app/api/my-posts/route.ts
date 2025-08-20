import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // server-only
);

// Supabase の URL または相対パスから、/api/media に渡す src を作る
function toMediaProxySrc(input: string): string {
  if (!input) return '';

  const raw = input.trim();

  // すでに /api/media 形式ならそのまま
  if (raw.startsWith('/api/media?path=')) return raw;

  // 相対パス (例: "669933/abc.png" など)。デフォルト bucket は private-posts
  if (!/^https?:\/\//i.test(raw)) {
    return `/api/media?path=${encodeURIComponent(`private-posts/${raw}`)}`;
  }

  // フルの Supabase URL の場合は bucket/key を抽出（sign/public の両方対応）
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/\/storage\/v1\/object\/(?:sign|public)\/([^/]+)\/(.+)/);
    if (m) {
      const bucket = m[1];
      const key = decodeURIComponent(m[2]); // 署名URLは key がエンコードされていることが多い
      return `/api/media?path=${encodeURIComponent(`${bucket}/${key}`)}`;
    }
  } catch {
    // 解析失敗時は fallthrough
  }

  // Supabase 以外の完全URL（外部画像など）はそのまま使う
  return raw;
}

export async function POST(req: NextRequest) {
  try {
    const ctype = req.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) {
      return NextResponse.json({ error: 'Content-Type must be application/json' }, { status: 415 });
    }

    const { user_code } = (await req.json().catch(() => ({}))) as { user_code?: string };
    if (!user_code) {
      return NextResponse.json({ error: 'user_code is required' }, { status: 400 });
    }

    // 自分の投稿のみ。アルバム用なので private を優先（必要に応じて外す/切替フラグ追加可）
    const { data: rows, error } = await supabase
      .from('posts')
      .select(
        `
        post_id,
        user_code,
        title,
        content,
        category,
        tags,
        media_urls,
        visibility,
        board_type,
        created_at
      `
      )
      .eq('user_code', user_code)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[my-posts] select error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    // 返却前に media_urls を /api/media に正規化（期限切れの署名URLは配らない）
    const normalized =
      (rows || [])
        // 任意: アルバムは private だけにしたい場合は以下を有効化
        // .filter((p) => p.visibility === 'private')
        .map((p) => {
          const list = Array.isArray(p.media_urls) ? p.media_urls : [];
          const proxied = list
            .map((item) => (typeof item === 'string' ? item : String(item)))
            .map(toMediaProxySrc)
            .filter(Boolean);

          return {
            ...p,
            media_urls: proxied,
          };
        })
        // 画像が1枚もない投稿は落とす（アルバム用途なので）
        .filter((p) => p.media_urls.length > 0);

    return NextResponse.json(
      { posts: normalized },
      {
        status: 200,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  } catch (e: any) {
    console.error('[my-posts] unexpected error:', e?.message || e);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
