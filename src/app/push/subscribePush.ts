// /app/api/push/subscribe/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: Request) {
  const { user_code, endpoint, keys, user_agent, platform } = await req.json();
  if (!user_code || !endpoint || !keys?.p256dh || !keys?.auth) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { error } = await supabase.from('push_subscriptions').upsert(
    {
      user_code,
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      user_agent: user_agent || '',
      platform: platform || '',
    },
    { onConflict: 'endpoint' },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
