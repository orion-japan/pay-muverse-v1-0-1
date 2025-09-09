// /app/api/talk/mirra/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(req: NextRequest) {
  const thread_id = req.nextUrl.searchParams.get('thread_id') || '';
  const user_code = req.nextUrl.searchParams.get('user_code') || '';
  if (!thread_id || !user_code) {
    return NextResponse.json({ error: 'bad_request' }, { status: 400 });
  }
  const { data, error } = await supabase
    .from('mirra_turns') // あれば
    .select('created_at,input_text,output_text,meta')
    .eq('user_code', user_code)
    .eq('thread_id', thread_id)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}
