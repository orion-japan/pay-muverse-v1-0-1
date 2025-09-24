// src/app/api/agent/mtalk/consult/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

type Body = {
  report_id: string;
  problem_text?: string;
  answer_text?: string;
  title?: string;
};

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

// conversations.owner_uid が必須なスキーマ向けに Uid を取得
async function getOwnerUidByUserCode(supabase: any, user_code: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('supabase_uid')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) return null;
  const uid = data?.supabase_uid as string | null;
  const isUuid =
    !!uid &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uid);
  return isUuid ? uid! : null;
}

export async function POST(req: NextRequest) {
  try {
    // --- 認可 ---
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // --- 入力 ---
    const body = (await req.json().catch(() => null)) as Body | null;
    if (!body?.report_id || typeof body.report_id !== 'string') {
      return json({ ok: false, error: 'report_id_required' }, 400);
    }

    // 1) レポート取得（本人チェック）
    const { data: rep, error: repErr } = await supabase
      .from('mtalk_reports')
      .select(
        'id, user_code, agent, reply_text, q_emotion, phase, depth_stage, conversation_id, created_at',
      )
      .eq('id', body.report_id)
      .maybeSingle();

    if (repErr || !rep) return json({ ok: false, error: 'report_not_found' }, 404);
    if (rep.user_code !== user_code) return json({ ok: false, error: 'forbidden' }, 403);

    // 2) 会話を用意（既存がなければ作る）
    let conversation_id: string = rep.conversation_id || randomUUID();

    if (!rep.conversation_id) {
      // owner_uid が必要なスキーマも考慮
      const owner_uid = await getOwnerUidByUserCode(supabase, user_code);

      const baseConv: any = {
        id: conversation_id,
        user_code,
        title: body?.title || 'mTalkからの相談',
        messages: [],
      };
      if (owner_uid) baseConv.owner_uid = owner_uid;

      const { error: convErr } = await supabase.from('conversations').insert(baseConv as any);
      if (convErr && !String(convErr.message || '').toLowerCase().includes('duplicate')) {
        console.warn('[mtalk/consult] conversations insert warn:', convErr.message);
      }

      // レポートにひも付け
      await supabase.from('mtalk_reports').update({ conversation_id }).eq('id', rep.id);
    } else if (body?.title) {
      // タイトル更新（任意）
      await supabase.from('conversations').update({ title: body.title }).eq('id', conversation_id);
    }

    // 3) 初期2メッセージ（問題/回答）
    const nowISO = new Date().toISOString();
    const problemText = (body?.problem_text?.trim() || '（mTalk）この相談の“問題”テキスト');
    const answerText = (body?.answer_text?.trim() || rep.reply_text || '（mTalk）この相談の“回答”テキスト');

    // a) 行テーブルがあれば試しに insert（無ければ info ログでスルー）
    const candidates = ['messages', 'talk_messages', 'mtalk_turns'] as const;
    for (const t of candidates) {
      const { error } = await supabase.from(t as any).insert([
        {
          id: randomUUID(),
          conversation_id,
          role: 'user',
          content: problemText,
          user_code,
          created_at: nowISO,
          origin: 'mtalk_consult',
        },
        {
          id: randomUUID(),
          conversation_id,
          role: 'assistant',
          content: answerText,
          user_code: null,
          created_at: nowISO,
          origin: 'mtalk_consult',
        },
      ] as any);
      if (error) console.info(`[mtalk/consult] insert try "${t}" ->`, error.message);
    }

    // b) JSONB messages にも push（UI は基本ここを読む）
    const { data: convRow, error: convGetErr } = await supabase
      .from('conversations')
      .select('messages')
      .eq('id', conversation_id)
      .maybeSingle();

    if (!convGetErr && convRow) {
      const current = Array.isArray((convRow as any)?.messages)
        ? ((convRow as any).messages as any[])
        : [];
      const next = [
        ...current,
        { role: 'user', content: problemText, created_at: nowISO, origin: 'mtalk_consult' },
        { role: 'assistant', content: answerText, created_at: nowISO, origin: 'mtalk_consult' },
      ];

      // last_turn_at が無いスキーマもあるので try で更新
      const { error: convUpdErr } = await supabase
        .from('conversations')
        .update({ messages: next, last_turn_at: nowISO } as any)
        .eq('id', conversation_id);

      if (convUpdErr) {
        console.warn('[mtalk/consult] conversations.messages update warn:', convUpdErr.message);
        // messages だけでも反映しておく
        await supabase.from('conversations').update({ messages: next } as any).eq('id', conversation_id);
      }
    } else if (convGetErr) {
      console.warn('[mtalk/consult] conversations select warn:', convGetErr.message);
    }

    // 4) 画面用ヒント生成
    const short = (rep.reply_text || '').replace(/\s+/g, ' ').slice(0, 220);
    const summary_hint =
      `Q=${rep.q_emotion}／位相=${rep.phase}／深度=${rep.depth_stage}／` +
      `${new Date(rep.created_at as any).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} 作成：${short}`;

    return json({
      ok: true,
      agent: 'mirra',
      conversation_id,
      redirect: `/talk/${conversation_id}?agent=mirra&from=mtalk`,
      summary_hint,
      seed_messages: [
        { role: 'user', content: problemText },
        { role: 'assistant', content: answerText },
      ],
    });
  } catch (err: any) {
    console.error('[mtalk/consult] error', err);
    return json({ ok: false, error: 'internal_error', detail: String(err?.message || err) }, 500);
  }
}
