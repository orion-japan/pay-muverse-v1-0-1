// src/app/api/register-push/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } }
);

type Body = {
  user_code?: string;
  endpoint?: string;
  keys?: { p256dh?: string; auth?: string };
};

export async function POST(req: NextRequest) {
  try {
    const { user_code, endpoint, keys } = (await req.json()) as Body;

    if (!user_code || !endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { ok: false, error: 'missing fields', got: { user_code, endpoint, keys } },
        { status: 400 }
      );
    }

    const { error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_code: String(user_code),
          endpoint: String(endpoint),
          p256dh: String(keys.p256dh),
          auth: String(keys.auth),
        },
        { onConflict: 'endpoint' } // endpoint に UNIQUE 制約を付与しておくと安定
      );

    if (error) {
      console.error('❌ Supabase upsert error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('❌ register-push API error:', err);
    return NextResponse.json({ ok: false, error: err?.message || 'server error' }, { status: 500 });
  }
}
