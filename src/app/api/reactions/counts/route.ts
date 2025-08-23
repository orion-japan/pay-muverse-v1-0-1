// /src/app/api/reactions/counts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// --- サーバー用 Supabase クライアント（環境変数に合わせてください）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string // ← RLS を跨ぐ必要がなければ anon key でもOK
);

export const dynamic = 'force-dynamic'; // キャッシュ抑制

type Totals = Record<string, number>;
type OneReq = { postId: string; isParent?: boolean };

/** 1ポスト分の集計 */
async function aggregateOne(postId: string, isParent: boolean): Promise<Totals> {
  // ↑ テーブル名/カラム名は環境に合わせて調整してください
  // 例: reactions(post_id UUID, r_type TEXT, is_parent BOOLEAN, thread_id UUID, ...)
  const { data, error } = await supabase
    .from('reactions')
    .select('r_type')
    .eq('post_id', postId)
    .eq('is_parent', isParent);

  if (error) {
    // 失敗でもゼロで返す：UI を安定させる
    return { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
  }

  const totals: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
  for (const row of data || []) {
    const k = String(row.r_type || '').toLowerCase();
    if (k in totals) totals[k] += 1;
  }
  return totals;
}

/** クエリ → boolean */
function parseBool(v: string | null): boolean {
  if (!v) return false;
  return v === 'true' || v === '1';
}

/** GET: /api/reactions/counts?scope=post&post_id=...&is_parent=true|false */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const postId = searchParams.get('post_id');
    const isParent = parseBool(searchParams.get('is_parent'));

    if (!postId) {
      return NextResponse.json({ ok: false, message: 'post_id is required' }, { status: 400 });
    }

    const totals = await aggregateOne(postId, isParent);
    return NextResponse.json({ ok: true, totals }, { status: 200 });
  } catch (e) {
    // 例外でも 200 + ゼロで返す（UI安定最優先）
    return NextResponse.json({ ok: true, totals: { like: 0, heart: 0, smile: 0, wow: 0, share: 0 } }, { status: 200 });
  }
}

/**
 * POST: 単発 or バッチ
 * body:
 *  - { postId: string, isParent?: boolean }
 *  - { items: Array<{ postId: string, isParent?: boolean }> }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const items: OneReq[] = Array.isArray(body?.items)
      ? body.items
      : body?.postId
      ? [{ postId: body.postId, isParent: !!body.isParent }]
      : [];

    if (!items.length) {
      return NextResponse.json({ ok: false, message: 'no items' }, { status: 400 });
    }

    // 並列集計
    const results = await Promise.all(
      items.map(async (it) => {
        const totals = await aggregateOne(it.postId, !!it.isParent);
        return { postId: it.postId, totals };
      })
    );

    // 単発は totals だけ返す（互換）
    if (!Array.isArray(body?.items) && body?.postId) {
      return NextResponse.json({ ok: true, totals: results[0]?.totals ?? {} }, { status: 200 });
    }

    // バッチは配列で返す
    return NextResponse.json({ ok: true, results }, { status: 200 });
  } catch (e) {
    // エラーでも空の形で返す
    return NextResponse.json({ ok: true, results: [] }, { status: 200 });
  }
}
