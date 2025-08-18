// src/app/api/friends/respond/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export async function POST(req: NextRequest) {
  const me = req.headers.get('x-user-code') ?? '';
  const { request_id, action } = await req.json(); // action: 'accepted' | 'declined' | 'blocked'

  const { error } = await supabase
    .from('friend_requests')
    .update({ status: action, responded_at: new Date().toISOString() })
    .eq('request_id', request_id)
    .eq('to_user_code', me);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
