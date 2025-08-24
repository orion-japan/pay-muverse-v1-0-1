import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export const dynamic = 'force-dynamic';

// GET /api/reactions/counts?post_id=...   → { totals: { like: n, ... } }
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const postId = searchParams.get('post_id');

    if (!postId) {
      return NextResponse.json({ error: 'post_id required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('post_resonances')
      .select('resonance_type')
      .eq('post_id', postId);

    if (error) throw error;

    const totals: Record<string, number> = {};
    for (const row of data ?? []) {
      const t = row.resonance_type as string;
      totals[t] = (totals[t] ?? 0) + 1;
    }

    return NextResponse.json({ totals });
  } catch (e: any) {
    console.error('[counts GET] error', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}

// POST { post_ids: string[] } → { counts: { [postId]: { [type]: number } } }
export async function POST(req: NextRequest) {
  try {
    const { post_ids } = await req.json();
    if (!Array.isArray(post_ids) || post_ids.length === 0) {
      return NextResponse.json({ error: 'post_ids required' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('post_resonances')
      .select('post_id,resonance_type')
      .in('post_id', post_ids);

    if (error) throw error;

    const counts: Record<string, Record<string, number>> = {};
    for (const row of data ?? []) {
      const pid = row.post_id as string;
      const t = row.resonance_type as string;
      if (!counts[pid]) counts[pid] = {};
      counts[pid][t] = (counts[pid][t] ?? 0) + 1;
    }
    for (const id of post_ids) if (!counts[id]) counts[id] = {};

    return NextResponse.json({ counts });
  } catch (e: any) {
    console.error('[counts POST] error', e);
    return NextResponse.json({ error: e?.message ?? 'server error' }, { status: 500 });
  }
}
