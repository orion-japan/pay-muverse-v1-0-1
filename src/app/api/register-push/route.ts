// /src/app/api/register-push/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';          // ★ 重要：EdgeではなくNodeで実行
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // ★ Service Role を必ず使う
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
    console.log('[register-push] inbound', {
      user_code,
      endpointLen: endpoint?.length,
      hasKeys: !!keys?.p256dh && !!keys?.auth,
    });

    if (!user_code || !endpoint || !keys?.p256dh || !keys?.auth) {
      return NextResponse.json(
        { ok: false, error: 'missing fields', got: { user_code, endpoint, keys } },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('push_subscriptions')
      .upsert(
        {
          user_code: String(user_code), // TEXT カラム想定（uuid=NG）
          endpoint: String(endpoint),
          p256dh: String(keys.p256dh),
          auth: String(keys.auth),
        },
        { onConflict: 'endpoint' } // endpoint UNIQUE 前提
      )
      .select('endpoint,user_code')
      .single();

    if (error) {
      console.error('❌ upsert error', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    console.log('[register-push] saved', data);
    return NextResponse.json({ ok: true, saved: data }, { status: 200 });
  } catch (err: any) {
    console.error('❌ register-push API error:', err);
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}
