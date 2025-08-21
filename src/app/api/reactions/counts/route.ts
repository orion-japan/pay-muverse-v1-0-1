// /app/api/reactions/counts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED = ['like', 'heart', 'smile', 'wow', 'share'] as const;
type Totals = Record<(typeof ALLOWED)[number], number>;
const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };

function b(v: string | null, fb = false) {
  if (v == null) return fb;
  return v === 'true' || v === '1';
}

/** 単一 post の集計（親/子を is_parent で切り替え） */
async function getByPost(post_id: string, is_parent: boolean): Promise<Totals> {
  const totals: Totals = { ...ZERO };
  for (const key of ALLOWED) {
    const { count, error } = await supabase
      .from('reactions')
      .select('*', { head: true, count: 'exact' })
      .eq('post_id', post_id)
      .eq('is_parent', is_parent)
      .eq('reaction', key);
    if (error) throw error;
    totals[key] = count ?? 0;
  }
  return totals;
}

/** スレッド全体（親＋子全 post_id 合算） */
async function getByThread(thread_id: string): Promise<Totals> {
  const { data: posts, error } = await supabase
    .from('posts')
    .select('post_id')
    .eq('thread_id', thread_id);
  if (error) throw error;

  const ids = (posts ?? []).map(p => p.post_id);
  if (!ids.length) return { ...ZERO };

  const totals: Totals = { ...ZERO };
  for (const key of ALLOWED) {
    const { count, error: e2 } = await supabase
      .from('reactions')
      .select('*', { head: true, count: 'exact' })
      .in('post_id', ids)
      .eq('reaction', key);
    if (e2) throw e2;
    totals[key] = count ?? 0;
  }
  return totals;
}

export async function GET(req: NextRequest) {
  try {
    const sp = new URL(req.url).searchParams;
    const scope = (sp.get('scope') || 'post') as 'post' | 'thread';

    if (scope === 'thread') {
      const thread_id = sp.get('thread_id') ?? '';
      if (!thread_id) {
        return NextResponse.json({ ok: false, message: 'thread_id is required', totals: ZERO }, { status: 400 });
      }
      const totals = await getByThread(thread_id);
      return NextResponse.json({ ok: true, scope: 'thread', thread_id, totals }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const post_id = sp.get('post_id') ?? '';
    const is_parent = b(sp.get('is_parent'), false);
    if (!post_id) {
      return NextResponse.json({ ok: false, message: 'post_id is required', totals: ZERO }, { status: 400 });
    }

    const totals = await getByPost(post_id, is_parent);
    return NextResponse.json({ ok: true, scope: 'post', post_id, is_parent, totals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[counts][GET] error', e);
    return NextResponse.json({ ok: false, message: e?.message || 'Unexpected error', totals: ZERO }, { status: 500 });
  }
}

// 後方互換（POST）
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body?.scope === 'thread' || body?.thread_id) {
      const totals = await getByThread(body.thread_id);
      return NextResponse.json({ ok: true, scope: 'thread', thread_id: body.thread_id, totals }, { headers: { 'Cache-Control': 'no-store' } });
    }
    const totals = await getByPost(body.post_id, !!body.is_parent);
    return NextResponse.json({ ok: true, scope: 'post', post_id: body.post_id, is_parent: !!body.is_parent, totals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[counts][POST] error', e);
    return NextResponse.json({ ok: false, message: e?.message || 'Unexpected error', totals: ZERO }, { status: 500 });
  }
}
