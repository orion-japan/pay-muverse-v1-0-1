// src/app/api/get-profile/route.ts
import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userCode = searchParams.get('code');

  if (!userCode) {
    return NextResponse.json({ error: 'code is required' }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from('profiles')
    .select('*')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) {
    console.error('[get-profile] DBエラー:', error);
    return NextResponse.json({ error: 'DB error' }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
  }

  return NextResponse.json(data);
}
