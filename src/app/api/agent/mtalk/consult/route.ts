// src/app/api/agent/mtalk/consult/route.ts
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

/** 既存チャットのテーブル名に合わせて必要なら変更してください */
const TABLES = {
  mu:   { sessions: 'muai_sessions',   messages: 'muai_messages'   },
  iros: { sessions: 'iros_sessions',   messages: 'iros_messages'   },
} as const;

/** iros 可否（例：plan_status が free の人は不可 → Mu にフォールバック） */
async function canUseIros(supabase: any, user_code: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('users')
    .select('plan_status')
    .eq('user_code', user_code)
    .maybeSingle();
  if (error) {
    console.warn('[mtalk/consult] canUseIros warn:', error.message);
    return false;
  }
  const plan = (data?.plan_status || 'free').toString();
  return plan !== 'free';
}

/** チャット会話へ “mTalk共有” を差し込み（テーブルが無ければ静かにスキップ） */
async function seedConversation(
  supabase: any,
  agent: 'mu' | 'iros',
  conversation_id: string,
  user_code: string,
  seedText: string,
  report_id: string,
) {
  const t = TABLES[agent];

  // セッション upsert
  const { error: upErr } = await supabase
    .from(t.sessions)
    .upsert(
      {
        id: conversation_id,
        user_code,
        title: 'mTalk相談',
        source: 'mtalk',
        created_at: new Date().toISOString(),
      } as any,
      { onConflict: 'id' },
    );
  if (upErr) {
    // テーブルが無い等 → スキップ
    if (String(upErr.message || '').includes('relation')) return;
    console.warn('[mtalk/consult] session upsert warn:', upErr.message);
  }

  // 共有メッセージ挿入
  const message = {
    session_id: conversation_id,
    role: 'system',
    content:
      `【mTalk共有】\nこの会話は mTalk から開始されました。\n` +
      `以下の“問題の核”を共有：\n\n${seedText}`,
    meta: { from: 'mtalk', report_id },
    created_at: new Date().toISOString(),
  };

  const { error: msgErr } = await supabase.from(t.messages).insert(message as any);
  if (msgErr) {
    if (!String(msgErr.message || '').includes('relation')) {
      console.warn('[mtalk/consult] seed message warn:', msgErr.message);
    }
  }
}

export async function POST(req: NextRequest) {
  try {
    // 認証
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 入力
    const body = (await req.json()) as Body;
    if (!body?.report_id) return json({ ok: false, error: 'report_id_required' }, 400);

    // レポート取得（本人チェック）
    const { data: rep, error: repErr } = await supabase
      .from('mtalk_reports')
      .select('id, user_code, agent, reply_text, q_emotion, phase, depth_stage, conversation_id, created_at')
      .eq('id', body.report_id)
      .single();
    if (repErr || !rep) return json({ ok: false, error: 'report_not_found' }, 404);
    if (rep.user_code !== user_code) return json({ ok: false, error: 'forbidden' }, 403);

    // iros → mu フォールバック判定
    let agent: 'mu' | 'iros' = (rep.agent as 'mu' | 'iros') || 'mu';
    let fallback = false;
    if (agent === 'iros') {
      const allowed = await canUseIros(supabase, user_code);
      if (!allowed) { agent = 'mu'; fallback = true; }
    }

    // 会話ID（既存が無ければ新規発行して保存）
    let conversation_id: string = rep.conversation_id || randomUUID();
    if (!rep.conversation_id) {
      const { error: upErr } = await supabase
        .from('mtalk_reports')
        .update({ conversation_id })
        .eq('id', rep.id);
      if (upErr) throw upErr;
    }

    // mTalk 要約（チャット側の冒頭に入れる）
    const short = (rep.reply_text || '').replace(/\s+/g, ' ').slice(0, 220);
    const seed =
      `Q=${rep.q_emotion}／位相=${rep.phase}／深度=${rep.depth_stage}\n` +
      `（${new Date(rep.created_at as any).toLocaleString()} 作成）\n` +
      `${short}${rep.reply_text && rep.reply_text.length > 220 ? '…' : ''}`;

    // 共有メッセージをチャット履歴に差し込み
    await seedConversation(supabase, agent, conversation_id, user_code, seed, rep.id);

    // /chat に遷移
    const redirect = `/chat?agent=${agent}&cid=${conversation_id}&from=mtalk`;

    return json({
      ok: true,
      agent,
      conversation_id,
      redirect,
      fallback,
      summary_hint: seed,
    });
  } catch (err: any) {
    console.error('[mtalk/consult] error', err);
    return json(
      { ok: false, error: 'internal_error', detail: String(err?.message || err) },
      500,
    );
  }
}
