// /app/api/knowledge/get/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const title = (searchParams.get('title') ?? '').trim();
  if (!title) return NextResponse.json({ item: null });

  const { data, error } = await supabase
    .from('app_knowledge')
    .select('area, intent, title, content, actions, tags')
    .ilike('title', title) // だいたい一致
    .limit(1)
    .maybeSingle();

  if (error) return NextResponse.json({ item: null, error: error.message }, { status: 500 });

  return NextResponse.json({ item: data, mode: 'knowledge' });
}
