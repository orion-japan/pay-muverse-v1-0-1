import { NextRequest, NextResponse } from 'next/server';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

webpush.setVapidDetails(
  'mailto:notice@example.com',
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { user_code, title, body, url } = await req.json();
    if (!user_code) return NextResponse.json({ error: 'user_code required' }, { status: 400 });

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('endpoint, p256dh, auth')
      .eq('user_code', user_code);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!subs || subs.length === 0) return NextResponse.json({ error: 'no subscription' }, { status: 404 });

    const payload = {
      title: title || 'テスト通知',
      body: body || 'これはテストです',
      url: url || '/', // sw.js の notificationclick で openWindow する先
    };

    const results: any[] = [];
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dh, auth: s.auth }
          } as any,
          JSON.stringify(payload)
        );
        results.push({ endpoint: s.endpoint, ok: true });
      } catch (err: any) {
        results.push({ endpoint: s.endpoint, ok: false, error: String(err) });
      }
    }
    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
