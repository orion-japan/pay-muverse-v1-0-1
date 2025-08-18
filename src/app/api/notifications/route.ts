// src/app/api/notifications/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export async function GET(req: NextRequest) {
  const userCode = req.headers.get('x-user-code') ?? '';
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get('limit') ?? '20');

  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_user_code', userCode)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, items: data });
}
