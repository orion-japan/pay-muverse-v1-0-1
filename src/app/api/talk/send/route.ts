// /app/api/talk/send/route.ts
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

type AuthzResultLoose = { user_code?: string; userCode?: string };

export async function POST(req: NextRequest) {
  try {
    // ✅ 修正1: req を渡す
    const auth = (await verifyFirebaseAndAuthorize(req)) as AuthzResultLoose;

    // ✅ 修正2: 両対応で取得
    const me = auth.user_code ?? auth.userCode;
    if (!me) return json({ ok: false, error: 'unauthorized' }, 401);

    const { thread_id, text } = await req.json();
    if (!thread_id || !text) {
      return json({ ok: false, error: 'thread_id and text are required' }, 400);
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

    // スレッド取得＆当事者チェック
    const { data: thread, error: e1 } = await supa
      .from('talk_threads')
      .select('*')
      .eq('id', thread_id)
      .single();

    if (e1) return json({ ok: false, error: e1.message }, 500);
    if (!thread) return json({ ok: false, error: 'thread not found' }, 404);

    const { user_a_code, user_b_code } = thread as { user_a_code: string; user_b_code: string };
    if (me !== user_a_code && me !== user_b_code) {
      return json({ ok: false, error: 'forbidden (not a participant)' }, 403);
    }
    const partner = me === user_a_code ? user_b_code : user_a_code;

    // 権限判定
    const { data: can, error: e2 } = await supa.rpc('can_user_talk_with', {
      p_user_code: me,
      p_partner_code: partner,
    });
    if (e2) return json({ ok: false, error: e2.message }, 500);
    if (!can) return json({ ok: false, error: 'Talk not allowed for this pair' }, 403);

    // 送信
    const { data: msg, error: e3 } = await supa
      .from('talk_messages')
      .insert({
        thread_id,
        sender_code: me,
        content: text,
      })
      .select('*')
      .single();

    if (e3) return json({ ok: false, error: e3.message }, 500);

    return json({ ok: true, message: msg }, 200);
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message || e) }, 500);
  }
}
