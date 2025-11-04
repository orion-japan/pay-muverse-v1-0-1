import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function uidToUserCode(uid: string) {
  const { data, error } = await supabase
    .from('users')
    .select('user_code')
    .eq('firebase_uid', uid)
    .maybeSingle();
  if (error || !data?.user_code) throw new Error('user_code not found for uid');
  return data.user_code as string;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as any;
    if (!body) return NextResponse.json({ error: 'invalid json' }, { status: 400 });

    const uid: string | undefined = body.uid;

    // 受け取り形を両対応: {subscription:{...}} または 直置き
    const s = body.subscription ?? body;
    const endpoint: string | undefined = s?.endpoint;
    const keys = s?.keys ?? {};
    const p256dh: string | undefined = keys.p256dh ?? s?.p256dh;
    const auth: string | undefined = keys.auth ?? s?.auth;

    if (!uid) return NextResponse.json({ error: 'uid required' }, { status: 400 });
    if (!endpoint) return NextResponse.json({ error: 'endpoint required' }, { status: 400 });
    if (!p256dh) return NextResponse.json({ error: 'p256dh required' }, { status: 400 });
    if (!auth) return NextResponse.json({ error: 'auth required' }, { status: 400 });

    const user_code = await uidToUserCode(uid);

    const { data, error } = await supabase
      .from('push_subscriptions')
      .upsert(
        [
          {
            user_code,
            endpoint,
            p256dh,
            auth,
            user_agent: body.user_agent ?? null,
            platform: body.platform ?? null,
          },
        ],
        { onConflict: 'endpoint' }, // endpoint を一意扱い
      )
      .select('id')
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json({ ok: true, id: data?.id ?? null });
  } catch (e: any) {
    // 例外は 500 で本文に詳細を返す（フロントで見えるように）
    return new NextResponse(typeof e?.message === 'string' ? e.message : 'server error', {
      status: 500,
    });
  }
}
