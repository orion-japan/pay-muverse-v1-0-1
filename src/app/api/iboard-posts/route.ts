import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

async function fetchPublic(board: string | null) {
  let query = supabaseServer
    .from('posts')
    .select('*')
    .eq('visibility', 'public')
    .eq('is_posted', true)
    .order('created_at', { ascending: false });

  if (board && board !== 'all') {
    // 'iboard' 指定など
    query = query.eq('board_type', board);
  }
  const { data, error } = await query;
  if (error) throw error;

  // privateストレージ画像は除外（保険）
  const filtered = (data || []).filter(
    (p) =>
      Array.isArray(p.media_urls) &&
      p.media_urls.every((u: any) => {
        const url = typeof u === 'string' ? u : u?.url || '';
        return url && !url.includes('/private-posts/');
      }),
  );
  return filtered;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const board = searchParams.get('board'); // 'iboard' | 'all' | null
    const posts = await fetchPublic(board);
    return NextResponse.json({ posts }, { status: 200 });
  } catch (e: any) {
    console.error('[qboard-posts][GET] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { board } = await req.json().catch(() => ({}));
    const posts = await fetchPublic(board ?? null);
    return NextResponse.json({ posts }, { status: 200 });
  } catch (e: any) {
    console.error('[qboard-posts][POST] error:', e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
