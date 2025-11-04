import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export async function GET(req: NextRequest) {
  const me = req.headers.get('x-user-code') ?? '';
  // 受信/送信の未処理を両方返す
  const [incoming, outgoing] = await Promise.all([
    supabase
      .from('friend_requests')
      .select('*')
      .eq('to_user_code', me)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supabase
      .from('friend_requests')
      .select('*')
      .eq('from_user_code', me)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
  ]);
  if (incoming.error) return NextResponse.json({ error: incoming.error.message }, { status: 500 });
  if (outgoing.error) return NextResponse.json({ error: outgoing.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, incoming: incoming.data, outgoing: outgoing.data });
}
