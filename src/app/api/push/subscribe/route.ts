import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabaseClient';

export async function POST(req: NextRequest) {
  const userCode = req.headers.get('x-user-code') ?? '';
  const { endpoint, keys, userAgent, platform } = await req.json();

  const { error } = await supabase
    .from('push_subscriptions')
    .insert({
      user_code: userCode,
      endpoint,
      p256dh: keys?.p256dh,
      auth: keys?.auth,
      user_agent: userAgent,
      platform
    })
    .select()
    .single();

  if (error && !String(error.message).includes('duplicate key')) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
