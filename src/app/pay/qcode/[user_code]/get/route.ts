// src/app/api/qcode/[user_code]/get/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(
  _req: NextRequest,
  { params }: { params: { user_code: string } }
) {
  const supabase = createClient(url, anon, { auth: { persistSession: false } });
  const user_code = decodeURIComponent(params.user_code);

  const { data, error } = await supabase
    .from('user_q_codes')
    .select('*')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ qcode: data ?? null });
}
