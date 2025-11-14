import { NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code');

  if (!user_code) {
    return NextResponse.json({ error: 'user_codeが必要です' }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from('posts')
    .select('*')
    .eq('user_code', user_code)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: '投稿取得に失敗しました', detail: error }, { status: 500 });
  }

  return NextResponse.json({ posts: data });
}
