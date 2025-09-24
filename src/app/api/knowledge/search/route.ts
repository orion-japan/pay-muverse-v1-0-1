// /app/api/knowledge/search/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase クライアント生成
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim();
  if (!q) {
    return NextResponse.json({ items: [] });
  }

  // タイトル・本文・タグの部分一致検索
  const { data, error } = await supabase
    .from('app_knowledge')
    .select('area, intent, title, content, actions, tags')
    .or(
      `title.ilike.%${q}%,content.ilike.%${q}%,tags.cs.{${q}}`
    )
    .limit(5);

  if (error) {
    console.error('❌ Supabase検索エラー:', error.message);
    return NextResponse.json({ items: [], error: error.message }, { status: 500 });
  }

  return NextResponse.json({ items: data, mode: 'knowledge' });
}
