import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || '';
  const limit = Number(searchParams.get('limit') || 20);

  if (!user_code) return NextResponse.json({ ok:false, message:'user_code required' }, { status:400 });

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_code', user_code)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ ok:false, message:error.message }, { status:500 });
  return NextResponse.json({ ok:true, items:data });
}

export async function PATCH(req: NextRequest) {
  const { ids = [], user_code } = await req.json().catch(() => ({}));
  if (!user_code || !Array.isArray(ids)) {
    return NextResponse.json({ ok:false, message:'user_code and ids[] required' }, { status:400 });
  }
  const { error } = await supabase.from('notifications')
    .update({ is_read: true })
    .in('notification_id', ids)
    .eq('user_code', user_code);
  if (error) return NextResponse.json({ ok:false, message:error.message }, { status:500 });
  return NextResponse.json({ ok:true });
}
