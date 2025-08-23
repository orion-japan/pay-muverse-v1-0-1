// /src/app/api/reactions/counts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export const dynamic = 'force-dynamic';

// POST { post_ids: string[] }
// 返り値: { counts: { [postId: string]: { [type: string]: number } } }
export async function POST(req: NextRequest) {
  try {
    const { post_ids } = await req.json();
    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return NextResponse.json({ error: 'post_ids required' }, { status: 400 });
    }

    // まとめて1回だけ取得
    const { data, error } = await supabase
      .from('post_resonances')
      .select('post_id,resonance_type')
      .in('post_id', post_ids);

    if (error) throw error;

    // 集計
    const counts: Record<string, Record<string, number>> = {};
    for (const row of data ?? []) {
      const pid = row.post_id as string;
      const t = row.resonance_type as string;
      if (!counts[pid]) counts[pid] = {};
      counts[pid][t] = (counts[pid][t] ?? 0) + 1;
    }

    // 空の投稿にもキーを用意（UIで扱いやすいように）
    for (const id of post_ids) if (!counts[id]) counts[id] = {};

    return NextResponse.json({ counts });
  } catch (e: any) {
    console.error('[counts] error', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
