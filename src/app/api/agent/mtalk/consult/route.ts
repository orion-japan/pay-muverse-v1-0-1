export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

type Body = { report_id: string };

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);

    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.report_id || typeof body.report_id !== 'string') {
      return json({ ok: false, error: 'report_id_required' }, 400);
    }

    // レポート取得（本人チェック）
    const { data: rep, error: repErr } = await supabase
      .from('mtalk_reports')
      .select(
        'id, user_code, agent, reply_text, q_emotion, phase, depth_stage, conversation_id, created_at',
      )
      .eq('id', body.report_id)
      .single();

    if (repErr || !rep) return json({ ok: false, error: 'report_not_found' }, 404);
    if (rep.user_code !== user_code) return json({ ok: false, error: 'forbidden' }, 403);

    // 会話ID（なければ新規発行し、conversations を最小で作成）
    let conversation_id: string = rep.conversation_id || randomUUID();
    if (!rep.conversation_id) {
      const { error: convErr } = await supabase.from('conversations').insert({
        id: conversation_id,
        user_code,
        title: 'mTalkからの相談',
        messages: [],
      } as any);
      if (convErr && !String(convErr.message || '').includes('duplicate')) {
        console.warn('[mtalk/consult] conversations insert warn:', convErr.message);
      }

      const { error: upErr } = await supabase
        .from('mtalk_reports')
        .update({ conversation_id })
        .eq('id', rep.id);
      if (upErr) {
        console.warn('[mtalk/consult] report update warn:', upErr.message);
      }
    }

    // チャット画面へ（mirra固定）
    const redirect = `/talk/${conversation_id}?agent=mirra&from=mtalk`;

    // 相談開始時に軽いヒント
    const short = (rep.reply_text || '').replace(/\s+/g, ' ').slice(0, 220);
    const summary_hint =
      `Q=${rep.q_emotion}／位相=${rep.phase}／深度=${rep.depth_stage}／` +
      `${new Date(rep.created_at as any).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} 作成：${short}`;

    return json({
      ok: true,
      agent: 'mirra',
      conversation_id,
      redirect,
      summary_hint,
    });
  } catch (err: any) {
    console.error('[mtalk/consult] error', err);
    return json(
      { ok: false, error: 'internal_error', detail: String(err?.message || err) },
      500,
    );
  }
}
