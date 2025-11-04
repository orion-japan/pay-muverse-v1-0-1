// /src/app/api/reactions/counts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// --- サーバー用 Supabase クライアント
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string, // RLS 影響を確実に避ける
);

export const dynamic = 'force-dynamic';

type Totals = Record<string, number>;
type OneReq = { postId: string; isParent?: boolean };

const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
const NO_STORE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

// ---- ここを reaction_totals ビュー参照に変更（最小限の差し替え） ----
async function aggregateOneFromView(postId: string): Promise<Totals> {
  // reaction_totals は (post_id uuid, is_parent bool, like int, heart int, ...) という形のVIEW想定
  const { data, error } = await supabase
    .from('reaction_totals')
    .select('like,heart,smile,wow,share')
    .eq('post_id', postId)
    .limit(1)
    .maybeSingle();

  if (error || !data) return { ...ZERO };

  return {
    like: Number((data as any).like || 0),
    heart: Number((data as any).heart || 0),
    smile: Number((data as any).smile || 0),
    wow: Number((data as any).wow || 0),
    share: Number((data as any).share || 0),
  };
}

function parseBool(v: string | null): boolean {
  if (!v) return false;
  return v === 'true' || v === '1';
}

/** GET: /api/reactions/counts?scope=post&post_id=...&is_parent=true|false */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const postId = searchParams.get('post_id');
    // is_parent は互換のため残すだけ。VIEW 側で必要なら列を使ってください。
    // const isParent = parseBool(searchParams.get('is_parent'));

    if (!postId) {
      return NextResponse.json(
        { ok: true, totals: { ...ZERO } },
        { status: 200, headers: NO_STORE },
      );
    }

    const totals = await aggregateOneFromView(postId);

    // どのプロジェクトに繋がっているか軽く確認できる短縮ログ（必要なら一時的に）
    // console.log('[counts] url=', process.env.NEXT_PUBLIC_SUPABASE_URL?.split('//')[1]);

    return NextResponse.json({ ok: true, totals }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json({ ok: true, totals: { ...ZERO } }, { status: 200, headers: NO_STORE });
  }
}

/** POST: 単発/バッチ両対応（構造はそのまま） */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}) as any);

    let items: OneReq[] = [];
    if (Array.isArray(body?.items)) {
      items = body.items.filter((it: any) => typeof it?.postId === 'string');
    } else if (Array.isArray(body?.post_ids)) {
      items = body.post_ids
        .filter((id: any) => typeof id === 'string')
        .map((id: string) => ({ postId: id }));
    } else if (typeof body?.postId === 'string') {
      items = [{ postId: body.postId, isParent: !!body.isParent }];
    }

    if (!items.length) {
      return NextResponse.json(
        { ok: true, counts: {}, results: [] },
        { status: 200, headers: NO_STORE },
      );
    }

    const results = await Promise.all(
      items.map(async (it) => {
        const totals = await aggregateOneFromView(it.postId);
        return { postId: it.postId, totals };
      }),
    );

    const counts: Record<string, Totals> = {};
    for (const r of results) counts[r.postId] = r.totals;

    if (!Array.isArray(body?.items) && !Array.isArray(body?.post_ids) && body?.postId) {
      return NextResponse.json(
        { ok: true, totals: results[0]?.totals ?? { ...ZERO } },
        { status: 200, headers: NO_STORE },
      );
    }

    return NextResponse.json({ ok: true, counts, results }, { status: 200, headers: NO_STORE });
  } catch {
    return NextResponse.json(
      { ok: true, counts: {}, results: [] },
      { status: 200, headers: NO_STORE },
    );
  }
}
