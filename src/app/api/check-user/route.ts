// /api/check-user/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(req: NextRequest) {
  const user_code = req.nextUrl.searchParams.get('code');
  if (!user_code) return NextResponse.json({ exists: false });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );

  const { data, error } = await supabase
    .from('users')
    .select('id')
    .eq('user_code', user_code)
    .single();

  return NextResponse.json({ exists: !!data });
}
