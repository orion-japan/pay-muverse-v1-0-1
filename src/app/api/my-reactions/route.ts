import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || '';
  const limit = Number(searchParams.get('limit') || 50);
  if (!user_code) return NextResponse.json({ ok:false, message:'user_code required' }, { status:400 });

  const [toMe, byMe] = await Promise.all([
    supabase.from('reaction_events').select('*')
      .eq('owner_user_code', user_code)
      .eq('added', true)
      .order('created_at', { ascending:false })
      .limit(limit),
    supabase.from('reaction_events').select('*')
      .eq('actor_user_code', user_code)
      .order('created_at', { ascending:false })
      .limit(limit),
  ]);

  if (toMe.error)  return NextResponse.json({ ok:false, message:toMe.error.message }, { status:500 });
  if (byMe.error)  return NextResponse.json({ ok:false, message:byMe.error.message }, { status:500 });

  return NextResponse.json({ ok:true, to_me: toMe.data, by_me: byMe.data });
}
