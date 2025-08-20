// /app/api/reactions/summary/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED = ['like', 'heart', 'smile', 'wow', 'share'] as const;
type Totals = Record<(typeof ALLOWED)[number], number>;
const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };
const z = (): Totals => ({ ...ZERO });

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || '';

  if (!user_code) {
    return NextResponse.json(
      { ok: false, message: 'user_code is required', received: z(), given: z(), totals: { received: 0, given: 0 } },
      { status: 400 }
    );
  }

  try {
    // 自分の post_id 一覧
    const { data: myPosts, error: postErr } = await supabase
      .from('posts')
      .select('post_id')
      .eq('user_code', user_code);
    if (postErr) {
      console.warn('[summary] posts warn', postErr.message);
    }
    const myPostIds: string[] = (myPosts ?? []).map(r => r.post_id);
    const safeIds = myPostIds.length ? myPostIds : ['00000000-0000-0000-0000-000000000000']; // in() の空配列対策

    // 受け取り（自分の投稿に付いた反応）
    const received: Totals = z();
    for (const key of ALLOWED) {
      const { count, error } = await supabase
        .from('reactions')
        .select('post_id', { count: 'exact', head: true })
        .eq('reaction', key)
        .in('post_id', safeIds);
      if (error) console.warn('[summary] received warn', key, error.message);
      received[key] = count ?? 0;
    }

    // 自分が押した
    const given: Totals = z();
    for (const key of ALLOWED) {
      const { count, error } = await supabase
        .from('reactions')
        .select('*', { count: 'exact', head: true })
        .eq('user_code', user_code)
        .eq('reaction', key);
      if (error) console.warn('[summary] given warn', key, error.message);
      given[key] = count ?? 0;
    }

    const totals = {
      received: Object.values(received).reduce((a, b) => a + b, 0),
      given: Object.values(given).reduce((a, b) => a + b, 0),
    };

    return NextResponse.json(
      { ok: true, user_code, received, given, totals },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e: any) {
    console.error('[summary] UNEXPECTED', e);
    return NextResponse.json(
      { ok: false, message: 'Unexpected error', received: z(), given: z(), totals: { received: 0, given: 0 } },
      { status: 500 }
    );
  }
}
