// /app/api/talk/start/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.['headers'],
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

/** ユーザーA/Bのコード順序を正規化（小さい方をAに） */
function normalizePair(a: string, b: string) {
  return a < b ? ([a, b] as const) : ([b, a] as const);
}

type AuthzResultLoose = { user_code?: string; userCode?: string };

export async function POST(req: NextRequest) {
  try {
    // ✅ 修正1: Headers ではなく req を渡す
    const auth = (await verifyFirebaseAndAuthorize(req)) as AuthzResultLoose;

    // ✅ 修正2: userCode / user_code 両対応
    const me = auth.user_code ?? auth.userCode;
    if (!me) return json({ ok: false, error: 'unauthorized' }, 401);

    const { partner_code } = await req.json();
    if (!partner_code) return json({ ok: false, error: 'partner_code required' }, 400);
    if (partner_code === me) return json({ ok: false, error: 'cannot start talk with self' }, 400);

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 権限判定
    const { data: can, error: e1 } = await supa.rpc('can_user_talk_with', {
      p_user_code: me,
      p_partner_code: partner_code,
    });
    if (e1) return json({ ok: false, error: e1.message }, 500);
    if (!can) return json({ ok: false, error: 'Talk not allowed for this pair' }, 403);

    // スレッド取得 or 作成
    const [a, b] = normalizePair(me, partner_code);
    const { data: existed, error: e2 } = await supa
      .from('talk_threads')
      .select('*')
      .eq('user_a_code', a)
      .eq('user_b_code', b)
      .maybeSingle();

    if (e2) return json({ ok: false, error: e2.message }, 500);
    if (existed) return json({ ok: true, thread: existed }, 200);

    const { data: created, error: e3 } = await supa
      .from('talk_threads')
      .insert({ user_a_code: a, user_b_code: b })
      .select('*')
      .single();

    if (e3) return json({ ok: false, error: e3.message }, 500);
    return json({ ok: true, thread: created }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
