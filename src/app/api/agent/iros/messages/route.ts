// src/app/api/agent/iros/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

// ✅ 追加：NextStep タグ除去 & 意図メタ取得
import {
  extractNextStepChoiceFromText,
  findNextStepOptionById,
} from '@/lib/iros/nextStepOptions';

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

/** --- 追加: 計測ヘルパ --- */
function msSince(t0: bigint) {
  return Number((process.hrtime.bigint() - t0) / BigInt(1e6));
}
function isUpstreamTimeout(err: any) {
  const msg = String(err?.message ?? err ?? '');
  return (
    msg.includes('timeout of 25000ms exceeded') ||
    msg.toLowerCase().includes('upstream-timeout') ||
    msg.toLowerCase().includes('timed out')
  );
}

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
          out.push(s[i], s[i + 1]);
          i++;
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

  return undefined;
}

/* ========= OPTIONS ========= */
export async function OPTIONS() {
  return json({ ok: true }, 200);
}

/* ========= GET /api/agent/iros/messages ========= */
export async function GET(req: NextRequest) {
  const t0 = process.hrtime.bigint();
  try {
    let auth: any;
    try {
      auth = await verifyFirebaseAndAuthorize(req);
    } catch (e: any) {
      const ms = msSince(t0);
      console.error('[IROS/messages][GET] authz throw', {
        ms,
        message: String(e?.message ?? e),
      });
      return json(
        { ok: false, error: 'authz_throw', detail: String(e?.message ?? e), ms },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      // upstream-timeout っぽい時は 504 に寄せる（401誤判定を防ぐ）
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      console.warn('[IROS/messages][GET] authz not ok', {
        ms,
        status,
        error: auth.error,
      });
      return json({ ok: false, error: auth.error, ms }, status);
    }

    const userCode =
      (auth.user?.user_code as string) ||
      (auth.user?.uid as string) ||
      (auth.userCode as string) ||
      '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    const cid = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!cid) return json({ ok: false, error: 'missing_conversation_id' }, 400);

    const limitRaw = req.nextUrl.searchParams.get('limit');
    const limit = (() => {
      if (!limitRaw) return 200;
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) return 200;
      return Math.min(n, 500);
    })();

    const includeMeta =
      req.nextUrl.searchParams.get('include_meta') === '1' ||
      req.nextUrl.searchParams.get('includeMeta') === '1';

    const supabase = sb();

    const tConv = process.hrtime.bigint();
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      'id,user_code',
      (q) => q.eq('id', cid).limit(1),
    );
    console.log('[IROS/messages][GET] conv select', {
      ms: msSince(tConv),
      ok: conv.ok,
      table: (conv as any).table,
    });

    if (conv.ok && (conv as any).data?.[0]) {
      const owner = String((conv as any).data[0].user_code ?? '');
      if (owner && owner !== userCode) {
        return json(
          {
            ok: true,
            messages: [],
            llm_messages: [],
            note: 'forbidden_owner_mismatch',
          },
          200,
        );
      }
    }

    const columnsBase =
      'id,conversation_id,user_code,role,content,text,q_code,depth_stage,intent_layer,color,created_at,ts';
    const columns = includeMeta ? `${columnsBase},meta` : columnsBase;

    const tSel = process.hrtime.bigint();
    const res = await trySelect<any>(
      supabase,
      MSG_TABLES,
      columns,
      (q) =>
        q.eq('conversation_id', cid).order('created_at', { ascending: false }).limit(limit),
    );
    console.log('[IROS/messages][GET] msg select', {
      ms: msSince(tSel),
      ok: res.ok,
      table: (res as any).table,
      rows: Array.isArray((res as any).data) ? (res as any).data.length : 0,
      includeMeta,
      limit,
    });

    if (!res.ok) {
      return json(
        { ok: true, messages: [], llm_messages: [], note: 'messages_select_failed' },
        200,
      );
    }

    const filtered = ((res as any).data ?? []).filter((m: any) => {
      if (!Object.prototype.hasOwnProperty.call(m, 'user_code')) return true;
      const uc = m.user_code == null ? '' : String(m.user_code);
      if (!uc) return true;
      return uc === userCode;
    });

    filtered.reverse();

    const messages: OutMsg[] = filtered.map((m: any) => ({
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
      meta: includeMeta ? m.meta ?? undefined : undefined,
    }));

    const llmLimitRaw = req.nextUrl.searchParams.get('llm_limit');
    const llmLimit = (() => {
      if (!llmLimitRaw) return 20;
      const n = Number(llmLimitRaw);
      if (!Number.isFinite(n) || n <= 0) return 20;
      return Math.min(n, 100);
    })();

    const llm_messages: LlmMsg[] = messages.slice(-llmLimit).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    console.log('[IROS/messages][GET] done', { ms: msSince(t0), count: messages.length });
    return json({ ok: true, messages, llm_messages }, 200);
  } catch (e: any) {
    const ms = msSince(t0);
    console.error('[IROS/messages][GET] exception', { ms, message: String(e?.message ?? e) });
    return json(
      {
        ok: true,
        messages: [],
        llm_messages: [],
        note: 'exception',
        detail: String(e?.message ?? e),
        ms,
      },
      200,
    );
  }
}

/* ========= POST /api/agent/iros/messages ========= */
export async function POST(req: NextRequest) {
  const t0 = process.hrtime.bigint();
  try {
    let auth: any;
    try {
      auth = await verifyFirebaseAndAuthorize(req);
    } catch (e: any) {
      const ms = msSince(t0);
      console.error('[IROS/messages][POST] authz throw', {
        ms,
        message: String(e?.message ?? e),
      });
      return json(
        { ok: false, error: 'authz_throw', detail: String(e?.message ?? e), ms },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      console.warn('[IROS/messages][POST] authz not ok', { ms, status, error: auth.error });
      return json({ ok: false, error: auth.error, ms }, status);
    }

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

    // ✅ raw を保持してから NextStep を剥がす
    const rawText: string = String(body?.text ?? body?.content ?? '');
    const { choiceId, cleanText } = extractNextStepChoiceFromText(rawText);
    const finalText = (cleanText && cleanText.trim().length ? cleanText : rawText).trim();

    const picked = choiceId ? findNextStepOptionById(choiceId) : null;

    const metaRaw = body?.meta ?? null;

    // ✅ meta.extra に nextStep 情報を隠して残す（reply と messages で同じ思想）
    const baseMetaRaw =
      metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
    const baseExtraRaw =
      baseMetaRaw.extra && typeof baseMetaRaw.extra === 'object' && !Array.isArray(baseMetaRaw.extra)
        ? baseMetaRaw.extra
        : {};

    const metaAugRaw = {
      ...baseMetaRaw,
      extra: {
        ...baseExtraRaw,
        nextStepChoiceId: choiceId ?? null,
        nextStepPickedMeta: picked?.meta ?? null,
      },
    };

    const q_code: string | null =
      metaAugRaw && typeof metaAugRaw === 'object' && typeof (metaAugRaw as any).qCode === 'string'
        ? (metaAugRaw as any).qCode
        : null;

    const depth_stage: string | null =
      metaAugRaw && typeof metaAugRaw === 'object' && typeof (metaAugRaw as any).depth === 'string'
        ? (metaAugRaw as any).depth
        : null;

    const intent_layer: string | null =
      metaAugRaw &&
      typeof metaAugRaw === 'object' &&
      typeof (metaAugRaw as any).intentLayer === 'string'
        ? (metaAugRaw as any).intentLayer
        : null;

    const metaSanitized = sanitizeJsonDeep(metaAugRaw);
    const meta =
      metaSanitized === null || typeof metaSanitized === 'undefined' ? null : metaSanitized;

    const role: 'user' | 'assistant' =
      String(body?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';

    if (!conversation_id)
      return json({ ok: false, error: 'missing_conversation_id' }, 400);
    if (!finalText) return json({ ok: false, error: 'text_empty' }, 400);

    const supabase = sb();

    // 所有確認
    const tConv = process.hrtime.bigint();
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      'id,user_code',
      (q) => q.eq('id', conversation_id).limit(1),
    );
    console.log('[IROS/messages][POST] conv select', {
      ms: msSince(tConv),
      ok: conv.ok,
      table: (conv as any).table,
    });

    if (!conv.ok || !(conv as any).data?.[0]) {
      return json({ ok: false, error: 'conversation_not_found' }, 404);
    }
    const owner = String((conv as any).data[0].user_code ?? '');
    if (owner && owner !== userCode) {
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);
    }

    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    // ✅ DBには必ず finalText（タグなし）
    const baseRow = {
      conversation_id,
      user_code: userCode,
      role,
      content: finalText,
      text: finalText,
      created_at: nowIso,
      ts: nowTs,
    };

    const baseRowWithQ = {
      ...baseRow,
      q_code,
    };

    let inserted: { id: string | number; created_at: string | null } | null = null;

    // テーブルごとに適した形で insert
    for (const table of MSG_TABLES) {
      const tIns = process.hrtime.bigint();
      let row: any;

      if (table === 'iros_messages' || table === 'public.iros_messages') {
        row = {
          ...baseRowWithQ,
          depth_stage,
          intent_layer,
          meta,
        };
      } else if (table === 'sofia_messages') {
        row = baseRowWithQ;
      } else if (table === 'messages') {
        row = baseRow;
      } else {
        row = baseRow;
      }

      try {
        const { data, error } = await (supabase as any)
          .from(table)
          .insert([row])
          .select('id,created_at')
          .single();

        console.log('[IROS/messages][POST] insert tried', {
          table,
          ms: msSince(tIns),
          ok: !error,
          hasData: !!data,
          err: error ? String(error.message ?? error) : null,
        });

        if (!error && data) {
          inserted = {
            id: data.id,
            created_at: data.created_at ?? nowIso,
          };
          break;
        }
      } catch (e) {
        console.log('[IROS/messages][POST] insert exception', {
          table,
          ms: msSince(tIns),
          err: String((e as any)?.message ?? e),
        });
      }
    }

    if (!inserted) {
      console.error('[IROS/messages][POST] insert failed all', { ms: msSince(t0) });
      return json({ ok: false, error: 'insert_failed_all_candidates', ms: msSince(t0) }, 500);
    }

// ✅ 先に strip の中身を出す（デバッグ情報）
console.log('[IROS/messages][POST] nextStep strip', {
  rawText,
  choiceId,
  cleanText,
  finalText,
});

// ✅ 最後に done（終わりの印）
console.log('[IROS/messages][POST] done', { ms: msSince(t0) });

return json({
  ok: true,
  message: {
    id: String(inserted.id),
    conversation_id,
    role,
    content: finalText,
    created_at: inserted.created_at,
  },
});

  } catch (e: any) {
    const ms = msSince(t0);
    console.error('[IROS/messages][POST] exception', { ms, message: String(e?.message ?? e) });
    return json(
      { ok: false, error: 'unhandled_error', detail: String(e?.message ?? e), ms },
      500,
    );
  }
}
