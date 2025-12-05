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
  depth_stage?: string | null;
  intent_layer?: string | null;
  meta?: any;
};


type LlmMsg = {
  role: 'user' | 'assistant';
  content: string;
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

/** JSON 用に Unicode をサニタイズする（壊れたサロゲートペアを削除） */
function sanitizeJsonDeep(value: any): any {
  if (value == null) return value;

  const t = typeof value;

  if (t === 'string') {
    const s = value;
    const out: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);

      // 高位サロゲート
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
        if (next >= 0xdc00 && next <= 0xdfff) {
          // 正しいペアはそのまま残す
          out.push(s[i], s[i + 1]);
          i++; // 下位サロゲートをスキップ
        } else {
          // ペアになっていない高位サロゲートは捨てる
        }
        continue;
      }

      // 単独の低位サロゲートも捨てる
      if (code >= 0xdc00 && code <= 0xdfff) {
        continue;
      }

      out.push(s[i]);
    }
    return out.join('');
  }

  if (t === 'number' || t === 'boolean') return value;

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonDeep(v));
  }

  if (t === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === 'undefined' || typeof v === 'function') continue;
      out[k] = sanitizeJsonDeep(v);
    }
    return out;
  }

  // それ以外（symbol, function など）は JSON に載せない
  return undefined;
}

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

    // メッセージ取得（★ meta / depth_stage / intent_layer も select）
    const res = await trySelect<{
      id: string;
      conversation_id: string;
      role: 'user' | 'assistant';
      content?: string | null;
      text?: string | null;
      user_code?: string | null;
      q_code?: OutMsg['q'] | null;
      color?: string | null;
      depth_stage?: string | null;
      intent_layer?: string | null;
      meta?: any;
      created_at?: string | null;
      ts?: number | null;
    }>(
      supabase,
      MSG_TABLES,
      'id,conversation_id,user_code,role,content,text,q_code,depth_stage,intent_layer,color,meta,created_at,ts',
      (q) => q.eq('conversation_id', cid).order('created_at', { ascending: true }),
    );

    if (!res.ok) {
      return json(
        { ok: true, messages: [], llm_messages: [], note: 'messages_select_failed' },
        200,
      );
    }

    // ★ user_code が null / 空 のレガシー行は許可する
    const filtered = res.data.filter((m) => {
      if (!Object.prototype.hasOwnProperty.call(m, 'user_code')) return true;
      const uc = m.user_code == null ? '' : String(m.user_code);
      if (!uc) return true;
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
      depth_stage: m.depth_stage ?? null,
      intent_layer: m.intent_layer ?? null,
      meta: m.meta ?? undefined,
      mirror: m.meta?.mirror ?? null,
      i_layer: m.meta?.i_layer ?? null,
      intent: m.meta?.intent ?? null,

    }));

    // ===== ここから追加：LLM にそのまま渡せる履歴 =====
    const llmLimitRaw = req.nextUrl.searchParams.get('llm_limit');
    const llmLimit = (() => {
      if (!llmLimitRaw) return 20;
      const n = Number(llmLimitRaw);
      if (!Number.isFinite(n) || n <= 0) return 20;
      return Math.min(n, 100);
    })();

    const slicedForLlm = messages.slice(-llmLimit);

    const llm_messages: LlmMsg[] = slicedForLlm.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    return json({ ok: true, messages, llm_messages }, 200);
  } catch (e: any) {
    return json(
      {
        ok: true,
        messages: [],
        llm_messages: [],
        note: 'exception',
        detail: String(e?.message ?? e),
      },
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
    const metaRaw = body?.meta ?? null;

    // --- meta から各種コードを抽出 ---
    const q_code: string | null =
      metaRaw && typeof metaRaw === 'object' && typeof metaRaw.qCode === 'string'
        ? metaRaw.qCode
        : null;

    const depth_stage: string | null =
      metaRaw && typeof metaRaw === 'object' && typeof metaRaw.depth === 'string'
        ? metaRaw.depth
        : null;

    const intent_layer: string | null =
      metaRaw &&
      typeof metaRaw === 'object' &&
      typeof metaRaw.intentLayer === 'string'
        ? metaRaw.intentLayer
        : null;

    // DB に投げる前に Unicode / undefined などをクリーンアップ
    const metaSanitized = sanitizeJsonDeep(metaRaw);
    const meta =
      metaSanitized === null || typeof metaSanitized === 'undefined'
        ? null
        : metaSanitized;

    const role: 'user' | 'assistant' =
      String(body?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';

    if (!conversation_id)
      return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!text) return json({ ok: false, error: 'text_empty' }, 400);

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

    // 共通カラム
    const baseRow = {
      conversation_id,
      user_code: userCode,
      role,
      content: text,
      text,
      created_at: nowIso,
      ts: nowTs,
    };

    // q_code は、あるテーブル（sofia / iros）にはあるが messages にはないので別扱い
    const baseRowWithQ = {
      ...baseRow,
      q_code,
    };

    let inserted: { id: string | number; created_at: string | null } | null = null;

    // テーブルごとに適した形で insert
    for (const table of MSG_TABLES) {
      let row: any;

      if (table === 'iros_messages' || table === 'public.iros_messages') {
        // 新スキーマ：meta / depth_stage / intent_layer あり
        row = {
          ...baseRowWithQ,
          depth_stage,
          intent_layer,
          meta,
        };
      } else if (table === 'sofia_messages') {
        // Sofia 時代のスキーマ：q_code まではある想定、meta 系は送らない
        row = baseRowWithQ;
      } else if (table === 'messages') {
        // 超レガシー：q_code も meta もないテーブルを想定
        row = baseRow;
      } else {
        // 想定外テーブルはとりあえず baseRow のみ
        row = baseRow;
      }

      try {
        const { data, error } = await (supabase as any)
          .from(table)
          .insert([row])
          .select('id,created_at')
          .single();

        if (!error && data) {
          inserted = {
            id: data.id,
            created_at: data.created_at ?? nowIso,
          };
          break;
        }

        if (error && process.env.NODE_ENV !== 'production') {
          console.warn('[IROS/messages] insert error', table, error);
        }
      } catch (e) {
        if (process.env.NODE_ENV !== 'production') {
          console.warn('[IROS/messages] insert exception', table, e);
        }
      }
    }

    if (!inserted) {
      return json({ ok: false, error: 'insert_failed_all_candidates' }, 500);
    }

    return json({
      ok: true,
      message: {
        id: String(inserted.id),
        conversation_id,
        role,
        content: text,
        created_at: inserted.created_at,
      },
    });
  } catch (e: any) {
    return json(
      { ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) },
      500,
    );
  }
}
