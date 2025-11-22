// src/app/api/agent/iros/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  });

/** 汎用 select（候補テーブルを順に試す） */
async function trySelect<T>(
  supabase: ReturnType<typeof sb>,
  tables: readonly string[],
  columns: string,
  modify: (q: any) => any,
) {
  for (const table of tables) {
    try {
      const { data, error } = await modify(
        (supabase as any).from(table).select(columns),
      );
      if (!error) return { ok: true as const, data, table };
    } catch {
      // ignore and try next
    }
  }
  return { ok: false, error: 'select_failed_all_candidates' };
}

/** 汎用 insert（候補テーブルを順に試す） */
async function tryInsert(
  supabase: ReturnType<typeof sb>,
  tables: readonly string[],
  row: Record<string, any>,
  returning: string,
) {
  for (const table of tables) {
    try {
      const { data, error } = await (supabase as any)
        .from(table)
        .insert([row])
        .select(returning)
        .single();
      if (!error) return { ok: true as const, data, table };
    } catch {
      // ignore and try next
    }
  }
  return { ok: false as const, error: 'insert_failed_all_candidates' };
}

/* ========= 型定義 ========= */

type OutMsg = {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  user_code?: string;
  created_at: string | null;
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;
};

const CONV_TABLES = [
  'iros_conversations',
  'public.iros_conversations',
  'sofia_conversations',
  'conversations',
] as const;

const MSG_TABLES = [
  'iros_messages',
  'public.iros_messages',
  'sofia_messages',
  'messages',
] as const;

/* ========= OPTIONS ========= */
export async function OPTIONS() {
  return json({ ok: true }, 200);
}

/* ========= GET /api/agent/iros/messages ========= */
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status || 401);

    const userCode =
      (auth.user?.user_code as string) ||
      (auth.user?.uid as string) ||
      (auth.userCode as string) ||
      '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    const cid = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!cid) return json({ ok: false, error: 'missing_conversation_id' }, 400);

    const supabase = sb();

    // 所有者確認
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      'id,user_code',
      (q) => q.eq('id', cid).limit(1),
    );
    if (conv.ok && conv.data[0]) {
      const owner = String(conv.data[0].user_code ?? '');
      if (owner && owner !== userCode)
        return json({ ok: true, messages: [], note: 'forbidden_owner_mismatch' }, 200);
    }

    // メッセージ取得
    const res = await trySelect<{
      id: string;
      conversation_id: string;
      role: 'user' | 'assistant';
      content?: string | null;
      text?: string | null;
      user_code?: string | null;
      q_code?: OutMsg['q'] | null;
      color?: string | null;
      created_at?: string | null;
      ts?: number | null;
    }>(
      supabase,
      MSG_TABLES,
      'id,conversation_id,user_code,role,content,text,q_code,color,created_at,ts',
      (q) => q.eq('conversation_id', cid).order('created_at', { ascending: true }),
    );
    if (!res.ok) return json({ ok: true, messages: [], note: 'messages_select_failed' }, 200);

    // ★ ここを修正：user_code が null / 空 のレガシー行は許可する
    const filtered = res.data.filter((m) => {
      // user_code カラム自体が無い → そのまま許可
      if (!Object.prototype.hasOwnProperty.call(m, 'user_code')) return true;

      const uc = m.user_code == null ? '' : String(m.user_code);

      // レガシー行（user_code 未設定）は許可
      if (!uc) return true;

      // userCode が明示的に入っている行だけ絞り込み
      return uc === userCode;
    });

    const messages: OutMsg[] = filtered.map((m) => ({
      id: String(m.id),
      conversation_id: String(m.conversation_id),
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: (m.content ?? m.text ?? '').toString(),
      user_code: m.user_code ?? undefined,
      created_at: m.created_at ?? null,
      q: m.q_code ?? undefined,
      color: m.color ?? undefined,
    }));

    return json({ ok: true, messages }, 200);
  } catch (e: any) {
    return json(
      { ok: true, messages: [], note: 'exception', detail: String(e?.message ?? e) },
      200,
    );
  }
}

/* ========= POST /api/agent/iros/messages ========= */
export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status || 401);

    const userCode =
      (auth.user?.user_code as string) ||
      (auth.user?.uid as string) ||
      (auth.userCode as string) ||
      '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const conversation_id: string = String(
      body?.conversation_id || body?.conversationId || '',
    ).trim();
    const text: string = String(body?.text ?? body?.content ?? '').trim();
    const meta = body?.meta ?? null;
    const q_code: string | null =
      meta && typeof meta === 'object' && typeof meta.qCode === 'string'
        ? meta.qCode
        : null;
    const role: 'user' | 'assistant' =
      String(body?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';

    if (!conversation_id)
      return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!text) return json({ ok: false, error: 'text_empty' }, 400);

    // ★ legacy assistant（二重保存）防止
    if (role === 'assistant' && !meta && !q_code) {
      console.log('[IROS/messages] skip legacy assistant without meta', {
        conversation_id,
      });
      return json({ ok: true, skipped: 'assistant_without_meta_legacy' }, 200);
    }

    const supabase = sb();

    // 所有確認
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      'id,user_code',
      (q) => q.eq('id', conversation_id).limit(1),
    );
    if (!conv.ok || !conv.data[0]) {
      return json({ ok: false, error: 'conversation_not_found' }, 404);
    }
    const owner = String(conv.data[0].user_code ?? '');
    if (owner && owner !== userCode) {
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);
    }

    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    // content/text は互換のため両方に保存
    const row = {
      conversation_id,
      user_code: userCode,
      role,
      content: text,
      text,
      q_code,
      meta,
      created_at: nowIso,
      ts: nowTs,
    };

    const ins = await tryInsert(supabase, MSG_TABLES, row, 'id,created_at');
    if (!ins.ok) return json({ ok: false, error: ins.error }, 500);

    return json({
      ok: true,
      message: {
        id: String(ins.data.id),
        conversation_id,
        role,
        content: text,
        created_at: ins.data.created_at ?? nowIso,
      },
    });
  } catch (e: any) {
    return json(
      { ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) },
      500,
    );
  }
}
