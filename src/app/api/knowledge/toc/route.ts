// /app/api/knowledge/toc/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

export async function GET() {
  const { data, error } = await supabase
    .from('app_knowledge')
    .select('area, title')
    .order('area', { ascending: true })
    .order('title', { ascending: true });

  if (error) return NextResponse.json({ items: [], error: error.message }, { status: 500 });

  // area ごとに titles をまとめる
  const map = new Map<string, string[]>();
  (data ?? []).forEach((r) => {
    if (!map.has(r.area)) map.set(r.area, []);
    map.get(r.area)!.push(r.title);
  });
  const items = Array.from(map.entries()).map(([area, titles]) => ({ area, titles }));
  return NextResponse.json({ items, mode: 'knowledge' });
}
