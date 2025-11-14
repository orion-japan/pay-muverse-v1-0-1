import { NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  const body = await req.json();
  const supabase = supabaseServer;

  const { user_code, ...updateData } = body;

  const { error } = await supabase.from('profiles').update(updateData).eq('user_code', user_code);

  if (error) {
    return NextResponse.json({ success: false, error });
  }

  return NextResponse.json({ success: true });
}
