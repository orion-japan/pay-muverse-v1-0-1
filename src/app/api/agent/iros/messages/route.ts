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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    },
  });

// ---- 返却形（フロント期待に寄せる）----
type OutMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string | null;
  q?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  color?: string;
};

// ---- テーブル候補（環境差吸収）----
const CONV_TABLE_CANDIDATES = [
  'iros_conversations',
  'public.iros_conversations',
  'sofia_conversations',
  'conversations',
] as const;

const MSG_TABLE_CANDIDATES = [
  'iros_messages',
  'public.iros_messages',
  'sofia_messages',
  'messages',
] as const;

/** 最初に成功する select を返すユーティリティ */
async function trySelect<T>(
  supabase: ReturnType<typeof sb>,
  tableNames: readonly string[],
  selectClause: string,
  q: (q: any) => any,
): Promise<{ ok: true; data: T[]; table: string } | { ok: false; error: string }> {
  for (const name of tableNames) {
    try {
      let query = (supabase as any).from(name).select(selectClause);
      query = q(query);
      const { data, error } = await query;
      if (!error) return { ok: true, data: (data as T[]) ?? [], table: name };
    } catch {
      // 次の候補へ
    }
  }
  return { ok: false, error: 'select_failed_all_candidates' };
}

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * GET /api/agent/iros/messages?conversation_id=UUID
 * 既存UI互換：失敗時でも 200/空配列 を返す
 * -------------------- */
export async function GET(req: NextRequest) {
  const safeReturn = (payload: any) => json(payload, 200);

  try {
    const cid = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!cid) {
      return safeReturn({ ok: true, messages: [], note: 'missing_conversation_id' });
    }

    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok) {
      return safeReturn({ ok: true, messages: [], note: 'unauthorized' });
    }
    const userCode = String(auth.userCode || '');

    const supabase = sb();

    // --- 所有者チェック（候補テーブルで試行。失敗しても続行） ---
    const convCheck = await trySelect<{ id: string; user_code: string }>(
      supabase,
      CONV_TABLE_CANDIDATES,
      'id,user_code',
      (q) => q.eq('id', cid).limit(1),
    );

    if (convCheck.ok && convCheck.data[0]) {
      const owner = String(convCheck.data[0].user_code ?? '');
      if (owner && owner !== userCode) {
        return safeReturn({ ok: true, messages: [], note: 'forbidden_owner_mismatch' });
      }
    }

    // --- メッセージ取得（候補テーブルで試行） ---
    const msgSelect = await trySelect<{
      id: string;
      conversation_id: string;
      user_code?: string | null;
      role: 'user' | 'assistant';
      content?: string | null;
      text?: string | null;
      q_code?: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | null;
      color?: string | null;
      created_at?: string | null;
      ts?: number | null;
    }>(
      supabase,
      MSG_TABLE_CANDIDATES,
      'id,conversation_id,user_code,role,content,text,q_code,color,created_at,ts',
      (q) =>
        q
          .eq('conversation_id', cid)
          .order('created_at', { ascending: true }),
    );

    if (!msgSelect.ok) {
      return safeReturn({ ok: true, messages: [], note: 'messages_select_failed' });
    }

    // user_code 列がある場合のみ本人に絞る
    const rows = msgSelect.data.filter((r) =>
      Object.prototype.hasOwnProperty.call(r, 'user_code')
        ? String((r as any).user_code ?? '') === userCode
        : true,
    );

    const messages: OutMsg[] = rows.map((r) => ({
      id: String(r.id),
      role: r.role,
      content: (r.content ?? r.text ?? '') || '',
      created_at: r.created_at ?? (r.ts ? new Date(r.ts).toISOString() : null),
      q: (r.q_code ?? undefined) as any,
      color: r.color ?? undefined,
    }));

    return safeReturn({ ok: true, messages });
  } catch (e: any) {
    return json(
      { ok: true, messages: [], note: 'exception', detail: e?.message || String(e) },
      200,
    );
  }
}

/** --------------------
 * POST /api/agent/iros/messages
 * 本文: { conversationId|conversation_id, text, role? }
 * text は必ず string 化して content/text へ保存
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error }, authz.status);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    const userCode: string =
      (typeof authz.user === 'string' && authz.user) ||
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (typeof (authz.user as any)?.uid === 'string' && (authz.user as any).uid) ||
      '';

    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      /* noop */
    }

    const conversation_id: string = String(
      body?.conversation_id || body?.conversationId || '',
    ).trim();

    const text: string = String(body?.text ?? '').trim();
    const role: 'user' | 'assistant' =
      (String(body?.role || 'user').toLowerCase() === 'assistant' ? 'assistant' : 'user');

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!text) return json({ ok: false, error: 'text_empty' }, 400);

    const supabase = sb();

    // 所有者チェック
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // 保存（content/text を両方埋める。CHECK 制約に合わせて role は2値のみ）
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    const { data: ins, error: insErr } = await supabase
      .from('iros_messages')
      .insert([
        {
          conversation_id,
          user_code: userCode,
          role,
          content: text,
          text,
          created_at: nowIso,
          ts: nowTs,
        },
      ])
      .select('id, created_at')
      .single();

    if (insErr || !ins) {
      return json({ ok: false, error: 'db_insert_failed', detail: insErr?.message }, 500);
    }

    return json({
      ok: true,
      message: {
        id: String(ins.id),
        conversation_id,
        role,
        content: text,
        created_at: ins.created_at ?? nowIso,
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
