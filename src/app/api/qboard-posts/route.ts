import { supabaseServer } from '@/lib/supabaseServer';
import { NextResponse } from 'next/server';

export async function POST() {
  console.log('========== [qboard-posts] API開始 ==========');

  const { data, error } = await supabaseServer
    .from('posts')
    .select('*')
    .eq('visibility', 'public')  // ✅ 公開投稿のみ取得（private画像除外はフロントで）
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[qboard-posts] ❌ 投稿取得失敗', error);
    return NextResponse.json({ error: '投稿取得失敗', detail: error }, { status: 500 });
  }

  console.log(`[qboard-posts] ✅ 投稿取得成功 件数: ${data.length}`);
  return NextResponse.json({ posts: data });
}
