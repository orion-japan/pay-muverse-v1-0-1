import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_ANON_KEY!,
);

export async function GET(req: Request) {
  const user = new URL(req.url).searchParams.get('user');
  if (!user) return NextResponse.json({ error: 'missing user' }, { status: 400 });

  const { data, error } = await supabase
    .from('v_user_q_features')
    .select('*')
    .eq('user_code', user)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ user, features: data });
}
