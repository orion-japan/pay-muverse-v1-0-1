// src/app/api/agent/iros/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

// ✅ NextStep タグ除去 & 意図メタ取得
import { extractNextStepChoiceFromText, findNextStepOptionById } from '@/lib/iros/nextStepOptions';

import crypto from 'crypto';
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

/* =========================
 * Utils
 * ========================= */

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

function asBool(v: string | null): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function toNonEmptyTrimmedString(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function pickMetaValue(meta: any, keys: string[]): string | null {
  if (!meta || typeof meta !== 'object') return null;
  for (const k of keys) {
    const v = (meta as any)[k];
    const s = toNonEmptyTrimmedString(v);
    if (s) return s;
  }
  return null;
}

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

      // 単独の低位サロゲートは捨てる
      if (code >= 0xdc00 && code <= 0xdfff) continue;

      out.push(s[i]);
    }
    return out.join('');
  }

  if (t === 'number' || t === 'boolean') return value;

  if (Array.isArray(value)) return value.map((v) => sanitizeJsonDeep(v));

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

/** 汎用 select（候補テーブルを順に試す） */
async function trySelect<T>(
  supabase: ReturnType<typeof sb>,
  tables: readonly string[],
  columnsByTable: Record<string, string>,
  modify: (q: any, table: string) => any,
) {
  for (const table of tables) {
    const columns = columnsByTable[table] ?? columnsByTable['*'] ?? '*';
    try {
      const { data, error } = await modify((supabase as any).from(table).select(columns), table);
      if (!error) return { ok: true as const, data, table };
    } catch {
      // ignore and try next
    }
  }
  return { ok: false as const, error: 'select_failed_all_candidates' as const };
}

// ✅ TS が「never」に落とす事故を避けつつ、text/number を安全に数値化
function toIntOrNull(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.floor(v));
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
  }
  return null;
}

/* =========================
 * Types / Tables
 * ========================= */

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

// ✅ iros の single source（混線/上書き防止）
// - sofia_conversations / conversations は完全に排除
const CONV_TABLES = ['iros_conversations', 'public.iros_conversations'] as const;

// ✅ 読み取りは view 優先（“本文 text の確定” を最優先）
const MSG_TABLES = [
  'v_iros_messages',
  'iros_messages_ui',
  'iros_messages_normalized',
  // fallback（テーブル直）
  'iros_messages',
  'public.iros_messages',
] as const;

/* =========================
 * OPTIONS
 * ========================= */
export async function OPTIONS() {
  return json({ ok: true }, 200);
}

/* =========================
 * GET
 * ========================= */
export async function GET(req: NextRequest) {
  const t0 = process.hrtime.bigint();
  try {
    // (A) Authz
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
        {
          ok: false,
          error: 'authz_throw',
          error_code: 'authz_throw',
          detail: String(e?.message ?? e),
          ms,
        },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      console.warn('[IROS/messages][GET] authz not ok', {
        ms,
        status,
        error: auth.error,
      });
      return json({ ok: false, error: auth.error, error_code: 'authz_not_ok', ms }, status);
    }

    const userCode =
      (auth.user?.user_code as string) ||
      (auth.user?.uid as string) ||
      (auth.userCode as string) ||
      '';
    if (!userCode) {
      return json({ ok: false, error: 'user_code_missing', error_code: 'user_code_missing' }, 400);
    }

    // (B) Params
    const cid = req.nextUrl.searchParams.get('conversation_id') || '';
    if (!cid) {
      return json(
        {
          ok: false,
          error: 'missing_conversation_id',
          error_code: 'missing_conversation_id',
        },
        400,
      );
    }

    const limitRaw = req.nextUrl.searchParams.get('limit');
    const limit = (() => {
      if (!limitRaw) return 200;
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) return 200;
      return Math.min(n, 500);
    })();

    // ✅ includeMeta:
    // - 明示指定があればそれを使う
    // - 無ければ admin は true（ops の SA/Y/H 等が消えない）
    const includeMetaParam =
      req.nextUrl.searchParams.get('include_meta') ?? req.nextUrl.searchParams.get('includeMeta');

    const includeMeta = includeMetaParam != null ? asBool(includeMetaParam) : auth.role === 'admin';

    const supabase = sb();

    // (C) Conversation owner check  ✅ FIX: 失敗/未取得のときはここで止める（漏洩防止）
    const tConv = process.hrtime.bigint();
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      { '*': 'id,user_code' },
      (q) => q.eq('id', cid).limit(1),
    );

    const convRow = conv.ok ? (conv as any).data?.[0] ?? null : null;

    console.log('[IROS/messages][GET] conv select', {
      ms: msSince(tConv),
      ok: conv.ok,
      table: (conv as any).table,
      hasRow: !!convRow,
    });

    // ✅ conv が取れない（select失敗/行なし）場合：
    // - 「存在可否を隠す」方針で ok:true + 空配列で返す（= messages select に進まない）
    if (!conv.ok || !convRow) {
      return json(
        {
          ok: true,
          messages: [],
          llm_messages: [],
          note: !conv.ok ? 'conv_select_failed_all_candidates' : 'conversation_not_found',
        },
        200,
      );
    }

    // ✅ owner mismatch も同様に「存在可否を隠す」目的で ok:true + 空配列
    const owner = String(convRow.user_code ?? '');
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

    // (D) Messages select
    const columnsForV = includeMeta
      ? [
          'message_id',
          'conversation_id',
          'user_code',
          'role',
          'text',
          'created_at',
          'sa',
          'polarity',
          'tension',
          'warmth',
          'clarity',
          'q_primary',
          'q_secondary',
          'q_mix_ratio',
          'layer',
          'phase',
          'intention_axis',
          'analysis',
          'exploration',
        ].join(',')
      : ['message_id', 'conversation_id', 'user_code', 'role', 'text', 'created_at'].join(',');

    const columnsForUI = ['id', 'conversation_id', 'user_code', 'role', 'text', 'created_at'].join(
      ',',
    );

    const columnsForNormalized = includeMeta
      ? ['id', 'conversation_id', 'user_code', 'role', 'content', 'meta', 'created_at', 'ts', 'q_code', 'color'].join(
          ',',
        )
      : ['id', 'conversation_id', 'user_code', 'role', 'content', 'created_at', 'ts', 'q_code', 'color'].join(
          ',',
        );

    const columnsForTable = includeMeta
      ? [
          'id',
          'conversation_id',
          'user_code',
          'role',
          'content',
          'text',
          'q_code',
          'depth_stage',
          'intent_layer',
          'color',
          'created_at',
          'ts',
          'streak_q',
          'streak_len',
          'qtu_from',
          'meta',
        ].join(',')
      : [
          'id',
          'conversation_id',
          'user_code',
          'role',
          'content',
          'text',
          'q_code',
          'depth_stage',
          'intent_layer',
          'color',
          'created_at',
          'ts',
          'streak_q',
          'streak_len',
          'qtu_from',
        ].join(',');

    const columnsByTable: Record<string, string> = {
      v_iros_messages: columnsForV,
      iros_messages_ui: columnsForUI,
      iros_messages_normalized: columnsForNormalized,
      iros_messages: columnsForTable,
      'public.iros_messages': columnsForTable,
      '*': columnsForTable,
    };

    const tSel = process.hrtime.bigint();
    const res = await trySelect<any>(supabase, MSG_TABLES, columnsByTable, (q) => {
      const base = q.eq('conversation_id', cid);
      // order は列が揃ってる created_at を優先（view も持ってる）
      return base.order('created_at', { ascending: false }).limit(limit);
    });

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
        {
          ok: false,
          error: 'messages_select_failed',
          error_code: 'messages_select_failed',
          messages: [],
          llm_messages: [],
        },
        200,
      );
    }

    // user_code 列がある場合は一致するものだけ返す
    const filtered = ((res as any).data ?? []).filter((m: any) => {
      if (!Object.prototype.hasOwnProperty.call(m, 'user_code')) return true;
      const uc = m.user_code == null ? '' : String(m.user_code);
      if (!uc) return true;
      return uc === userCode;
    });

    filtered.reverse();

    const messages: OutMsg[] = filtered.map((m: any) => {
      // view の場合 message_id が主キー、UI view の場合 id、テーブルの場合 id
      const idVal = m.message_id ?? m.id ?? '';
      const contentVal = (m.text ?? m.content ?? '').toString();

      // q は v_iros_messages の q_primary を優先、無ければ q_code
      const qAny = (m.q_primary ?? m.q_code ?? null) as any;

      return {
        id: String(idVal),
        conversation_id: String(m.conversation_id),
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: contentVal,
        user_code: m.user_code ?? undefined,
        created_at: m.created_at ?? null,
        q: qAny ?? undefined,
        color: m.color ?? undefined,
        depth_stage: m.depth_stage ?? null,
        intent_layer: m.intent_layer ?? null,
        meta: includeMeta ? (m.meta ?? undefined) : undefined,
      };
    });

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

    console.log('[IROS/messages][GET] done', {
      ms: msSince(t0),
      count: messages.length,
      source: (res as any).table,
    });

    return json(
      { ok: true, messages, llm_messages, includeMeta, source: (res as any).table },
      200,
    );
  } catch (e: any) {
    const ms = msSince(t0);
    console.error('[IROS/messages][GET] exception', {
      ms,
      message: String(e?.message ?? e),
    });
    return json(
      {
        ok: false,
        error: 'exception',
        error_code: 'exception',
        messages: [],
        llm_messages: [],
        detail: String(e?.message ?? e),
        ms,
      },
      200,
    );
  }
}

/* =========================
 * POST
 * ========================= */
export async function POST(req: NextRequest) {
  const t0 = process.hrtime.bigint();
  try {
    // (A) Authz
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
        {
          ok: false,
          error: 'authz_throw',
          error_code: 'authz_throw',
          detail: String(e?.message ?? e),
          ms,
        },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      console.warn('[IROS/messages][POST] authz not ok', { ms, status, error: auth.error });
      return json({ ok: false, error: auth.error, error_code: 'authz_not_ok', ms }, status);
    }

    const userCode =
      (auth.user?.user_code as string) ||
      (auth.user?.uid as string) ||
      (auth.userCode as string) ||
      '';
    if (!userCode) {
      return json({ ok: false, error: 'user_code_missing', error_code: 'user_code_missing' }, 400);
    }

    // (B) Body
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    // ✅ reqId: client優先 -> header -> server生成（/reply の [IROS/REQ] in と突き合わせるため）
    const reqId: string =
      (typeof body?.reqId === 'string' && body.reqId.trim()) ||
      (typeof body?.requestId === 'string' && body.requestId.trim()) ||
      (req.headers.get('x-request-id')?.trim() || '') ||
      crypto.randomUUID();

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();

    const role: 'user' | 'assistant' =
      String(body?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';

    const rawText: string = String(body?.text ?? body?.content ?? '');

    // ✅ 入口ログ（/reply の [IROS/REQ] in と同じ軸）
    console.log('[IROS/MSG] in', {
      reqId,
      conversationId: conversation_id,
      userCode,
      uid: auth.user?.uid ?? null,
      role,
      textHead: rawText.slice(0, 80),
    });

    // ✅ single-writer: /messages は user だけ保存。assistant は絶対保存しない。
    if (role === 'assistant') {
      console.log('[IROS/messages][POST] hard-skip assistant persist (single-writer)', {
        conversation_id,
        reqId,
      });

      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'ASSISTANT_ROLE_NEVER_PERSISTED_SINGLE_WRITER',
        reqId,
      });
    }

    if (!rawText || !String(rawText).trim()) {
      return json({ ok: false, error: 'text_empty', error_code: 'text_empty', reqId }, 400);
    }

    // (C) NextStep choiceId 抽出（user のときだけ採用）
    const extracted =
      role === 'user'
        ? extractNextStepChoiceFromText(rawText)
        : { choiceId: null, cleanText: String(rawText ?? '') };

    const choiceIdFromBody: string | null = (() => {
      const c1 = body?.choiceId ?? body?.extractedChoiceId ?? null;
      if (typeof c1 === 'string' && c1.trim()) return c1.trim();

      const m = body?.meta;
      if (m && typeof m === 'object' && !Array.isArray(m)) {
        const c2 = (m as any).choiceId ?? (m as any).extractedChoiceId ?? null;
        if (typeof c2 === 'string' && c2.trim()) return c2.trim();

        const ex = (m as any).extra;
        if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
          const c3 = (ex as any).choiceId ?? (ex as any).extractedChoiceId ?? null;
          if (typeof c3 === 'string' && c3.trim()) return c3.trim();
        }
      }
      return null;
    })();

    const choiceId: string | null = role === 'user' ? (choiceIdFromBody ?? extracted.choiceId ?? null) : null;

    // user のときだけタグ剥がしされた cleanText を採用
    const cleanText = extracted.cleanText;
    const finalText = (role === 'user' && cleanText && cleanText.trim().length ? cleanText : rawText).trim();

    if (!finalText) {
      return json({ ok: false, error: 'text_empty', error_code: 'text_empty' }, 400);
    }

    const picked = choiceId ? findNextStepOptionById(choiceId) : null;

    // (D) meta を組み立て（nextStep は meta.extra に隠す）
    const metaRaw = body?.meta ?? null;

    const baseMetaRaw = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
    const baseExtraRaw =
      baseMetaRaw.extra && typeof baseMetaRaw.extra === 'object' && !Array.isArray(baseMetaRaw.extra)
        ? baseMetaRaw.extra
        : {};

    const pickedSnapshot =
      picked && typeof picked === 'object'
        ? {
            id: (picked as any).id ?? choiceId ?? null,
            label: (picked as any).label ?? (picked as any).title ?? (picked as any).name ?? null,
          }
        : null;

    // ✅ 追加：押したボタンの “効くmeta” を保存（renderMode/itTarget/requestedDepth...）
    const pickedMeta = picked && typeof picked === 'object' ? (picked as any).meta ?? null : null;

    const metaAugRaw = {
      ...baseMetaRaw,
      extra: {
        ...baseExtraRaw,
        nextStepChoiceId: choiceId ?? null,
        nextStepPicked: pickedSnapshot,
        nextStepPickedMeta: pickedMeta, // ✅ 追加
      },
    };

    const metaSanitized = sanitizeJsonDeep(metaAugRaw);
    const meta = metaSanitized === null || typeof metaSanitized === 'undefined' ? null : metaSanitized;

    // (E) q/depth/intent を body + meta から拾う（insert の primary）
    const q_code_from_body =
      toNonEmptyTrimmedString(body?.q_code) ??
      toNonEmptyTrimmedString(body?.qCode) ??
      toNonEmptyTrimmedString(body?.q_primary) ??
      toNonEmptyTrimmedString(body?.qPrimary) ??
      toNonEmptyTrimmedString((body as any)?.q) ??
      null;

    const depth_stage_from_body =
      toNonEmptyTrimmedString(body?.depth_stage) ??
      toNonEmptyTrimmedString(body?.depthStage) ??
      toNonEmptyTrimmedString(body?.depth) ??
      null;

    const intent_layer_from_body =
      toNonEmptyTrimmedString(body?.intent_layer) ?? toNonEmptyTrimmedString(body?.intentLayer) ?? null;

    const q_code: string | null =
      pickMetaValue(metaAugRaw, ['qCode', 'q_code', 'qPrimary', 'q_code_primary']) ?? q_code_from_body ?? null;

    const depth_stage: string | null =
      pickMetaValue(metaAugRaw, ['depth', 'depthStage', 'depth_stage']) ?? depth_stage_from_body ?? null;

    const intent_layer: string | null =
      pickMetaValue(metaAugRaw, ['intentLayer', 'intent_layer']) ?? intent_layer_from_body ?? null;

    // (F) Supabase + owner check
    const supabase = sb();

    const tConv = process.hrtime.bigint();
    const conv = await trySelect<{ id: string; user_code?: string | null }>(
      supabase,
      CONV_TABLES,
      { '*': 'id,user_code' },
      (q) => q.eq('id', conversation_id).limit(1),
    );
    console.log('[IROS/messages][POST] conv select', {
      ms: msSince(tConv),
      ok: conv.ok,
      table: (conv as any).table,
    });

    if (!conv.ok || !(conv as any).data?.[0]) {
      return json({ ok: false, error: 'conversation_not_found', error_code: 'conversation_not_found' }, 404);
    }
    const owner = String((conv as any).data[0].user_code ?? '');
    if (owner && owner !== userCode) {
      return json({ ok: false, error: 'forbidden_owner_mismatch', error_code: 'forbidden_owner_mismatch' }, 403);
    }

    /* =========================================================
     * (G) seed: MemoryState の値を “暫定補完” にだけ使う
     * - ★重要: このファイルでは memoryState 変数を使わない
     * ========================================================= */
    let seed: {
      q_code: string | null;
      depth_stage: string | null;
      intent_layer: string | null;
      phase: string | null;
      spin_loop: string | null;
      spin_step: number | null;
      descent_gate: string | null;

      q_trace: any | null;
      streak_q: string | null;
      streak_len: number | null;
      qtu_from: string | null;
    } = {
      q_code: null,
      depth_stage: null,
      intent_layer: null,
      phase: null,
      spin_loop: null,
      spin_step: null,
      descent_gate: null,
      q_trace: null,
      streak_q: null,
      streak_len: null,
      qtu_from: null,
    };

    function extractQTraceFromQCounts(qCounts: any): any | null {
      if (!qCounts || typeof qCounts !== 'object') return null;
      const qt = (qCounts as any).q_trace;
      if (!qt || typeof qt !== 'object') return null;
      return qt;
    }

    function applyTraceToSeed(trace: any, seedIn: typeof seed): typeof seed {
      if (!trace || typeof trace !== 'object') return seedIn;

      const sQ =
        typeof trace?.streakQ === 'string' && trace.streakQ.trim().length ? trace.streakQ.trim() : null;

      const sLen =
        typeof trace?.streakLength === 'number' && Number.isFinite(trace.streakLength)
          ? Math.max(0, Math.floor(trace.streakLength))
          : typeof trace?.streakLength === 'string' &&
              trace.streakLength.trim().length &&
              Number.isFinite(Number(trace.streakLength))
            ? Math.max(0, Math.floor(Number(trace.streakLength)))
            : null;

      const from = typeof trace?.from === 'string' && trace.from.trim().length ? trace.from.trim() : null;

      return {
        ...seedIn,
        q_trace: trace,
        streak_q: sQ ?? seedIn.streak_q,
        streak_len: sLen ?? seedIn.streak_len,
        qtu_from: from ?? seedIn.qtu_from,
      };
    }

    async function loadMemoryStateSeed() {
      const memTables = ['iros_memory_state', 'public.iros_memory_state'] as const;
      const selectMin = 'q_primary, depth_stage, intent_layer, phase, spin_loop, spin_step, descent_gate, q_counts';

      for (const mt of memTables) {
        try {
          const { data, error } = await (supabase as any)
            .from(mt)
            .select(selectMin)
            .eq('user_code', userCode)
            .maybeSingle();
          if (!error && data) return data;
        } catch {}
      }
      return null;
    }

    try {
      const data = await loadMemoryStateSeed();
      if (data) {
        const qPrimary = toNonEmptyTrimmedString((data as any).q_primary) ?? null;
        const depthStage = toNonEmptyTrimmedString((data as any).depth_stage) ?? null;
        const intentLayer = toNonEmptyTrimmedString((data as any).intent_layer) ?? null;

        seed = {
          q_code: qPrimary,
          depth_stage: depthStage,
          intent_layer: intentLayer,
          phase: toNonEmptyTrimmedString((data as any).phase) ?? null,
          spin_loop: toNonEmptyTrimmedString((data as any).spin_loop) ?? null,
          spin_step:
            typeof (data as any).spin_step === 'number' && Number.isFinite((data as any).spin_step)
              ? (data as any).spin_step
              : null,
          descent_gate: toNonEmptyTrimmedString((data as any).descent_gate) ?? null,

          q_trace: null,
          streak_q: null,
          streak_len: null,
          qtu_from: null,
        };

        const qTraceFromCounts = extractQTraceFromQCounts((data as any).q_counts);
        seed = applyTraceToSeed(qTraceFromCounts, seed);
      }
    } catch {
      // seed は取れなくても続行
    }

    /* =========================================================
     * (H) intent_layer 正規化（depth_stage → intent_layer 同期）
     * ========================================================= */
    function normalizeIntentLayerFromDepth(depthStage: string | null): string | null {
      if (!depthStage) return null;
      const c = String(depthStage).trim().charAt(0).toUpperCase();
      return c === 'S' || c === 'R' || c === 'C' || c === 'I' || c === 'T' ? c : null;
    }

    const q_code_final = q_code ?? seed.q_code;
    const depth_stage_final = depth_stage ?? seed.depth_stage;

    const intent_layer_from_depth = normalizeIntentLayerFromDepth(depth_stage_final);
    const intent_layer_final = intent_layer_from_depth ?? (intent_layer ?? seed.intent_layer);

/* =========================================================
 * (I) streak 決定（meta → seed → fallback）
 * - ★重要: let（後で補正するため）
 * - 追加: DBから「会話内の直近 user 投稿」を見て streak を確定（seed由来のズレ防止）
 * - ✅ FIX: public 側に書かれていても拾えるように候補テーブルを試す
 * ========================================================= */

async function computeUserStreakFromDb(args: {
  supabase: any;
  conversationId: string;
  userCode: string;
  qCodeFinal: string | null;
}): Promise<{ streak_q: string | null; streak_len: number | null; qtu_from: string | null }> {
  const { supabase, conversationId, userCode, qCodeFinal } = args;

  const qFinal = typeof qCodeFinal === 'string' ? qCodeFinal.trim() : '';
  if (!qFinal) return { streak_q: null, streak_len: null, qtu_from: null };

  const tables = ['iros_messages', 'public.iros_messages'] as const;

  for (const table of tables) {
    try {
      // 直近の user 投稿だけ見る（現在の投稿はまだinsert前なので含まれない）
      const { data, error } = await supabase
        .from(table)
        .select('q_code, role, created_at')
        .eq('conversation_id', conversationId)
        .eq('user_code', userCode)
        .eq('role', 'user')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) {
        console.warn('[IROS/messages][streak-db] select failed', {
          table,
          message: error?.message ?? String(error),
        });
        continue;
      }

      const rows: any[] = Array.isArray(data) ? data : [];

      // 直近から「同一q_codeの連続」を数える（prev streak）
      let prevRun = 0;
      for (const r of rows) {
        const q = typeof r?.q_code === 'string' ? r.q_code.trim() : '';
        if (!q) continue;
        if (q === qFinal) prevRun += 1;
        else break;
      }

      // 今回の投稿を加えた streak
      const streakLen = prevRun + 1;

      return {
        streak_q: qFinal,
        streak_len: streakLen,
        qtu_from: `db:${table}`,
      };
    } catch (e: any) {
      console.warn('[IROS/messages][streak-db] select exception', {
        table,
        message: String(e?.message ?? e),
      });
      continue;
    }
  }

  // どの候補テーブルでも取れなかった
  return { streak_q: null, streak_len: null, qtu_from: null };
}

    const qtu: any = (meta as any)?.qTraceUpdated ?? (meta as any)?.qTrace ?? null;

    let streakQ: string | null =
      typeof qtu?.streakQ === 'string' && qtu.streakQ.trim().length > 0
        ? qtu.streakQ.trim()
        : seed.streak_q ?? (q_code_final ?? null);

    const seedStreakLenNum = toIntOrNull((seed as any)?.streak_len);

    let streakLenNum: number | null =
      typeof qtu?.streakLength === 'number' && Number.isFinite(qtu.streakLength)
        ? Math.max(0, Math.floor(qtu.streakLength))
        : seedStreakLenNum != null
        ? seedStreakLenNum
        : q_code_final
        ? 1
        : null;

    let qtuFrom: string | null =
      typeof qtu?.from === 'string' && qtu.from.trim().length > 0
        ? qtu.from.trim()
        : (meta as any)?.qTraceUpdated
        ? 'qTraceUpdated'
        : qtu
        ? 'qTrace'
        : seed.qtu_from ?? null;

    // ✅ 追加: DBで確定した streak を「増やす方向だけ」上書き（巻き戻り防止）
    {
      const db = await computeUserStreakFromDb({
        supabase,
        conversationId: conversation_id,
        userCode,
        qCodeFinal: q_code_final ?? null,
      });

      if (db.streak_q && db.streak_len != null) {
        // q が確定できるなら、streak_q はDBを優先
        streakQ = db.streak_q;

        // len は「小さくなる事故」を防ぐ（増やす方向のみ）
        const cur =
          typeof streakLenNum === 'number' && Number.isFinite(streakLenNum) ? streakLenNum : 0;
        if (db.streak_len > cur) {
          console.warn('[IROS/messages][streak-db] bump streakLen', {
            before: streakLenNum,
            after: db.streak_len,
            q: db.streak_q,
            from: db.qtu_from,
          });
          streakLenNum = db.streak_len;
          qtuFrom = db.qtu_from ?? qtuFrom;
        } else {
          // lenは増やさないが、「由来だけ」残すのは混乱するので、ここでは触らない
        }
      }
    }

    // ✅ FIX: seed（MemoryState由来）と矛盾しないように補正（増やす方向のみ）
    {
      const qFromSeed = seed.q_code ?? null;
      const streakLenFromSeed = seed.streak_len ?? null;
      const streakQFromSeed = seed.streak_q ?? null;

      if (q_code_final && qFromSeed && q_code_final === qFromSeed) {
        if (streakLenFromSeed != null) {
          if (typeof streakLenNum === 'number' && streakLenNum < streakLenFromSeed) {
            console.warn('[IROS/messages][streak-fix] bump streakLen', {
              before: streakLenNum,
              after: streakLenFromSeed,
              q_code: q_code_final,
              from: 'seed(memory_state)',
            });
            streakLenNum = streakLenFromSeed;
          } else if (streakLenNum == null) {
            streakLenNum = streakLenFromSeed;
          }
        }

        if (streakQFromSeed && (!streakQ || streakQ !== streakQFromSeed)) {
          streakQ = streakQFromSeed;
        }
      }
    }

    /* =========================================================
     * (J) insert row base
     * ========================================================= */
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

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
      q_code: q_code_final,
    };

    let inserted: { id: string | number; created_at: string | null } | null = null;

    // ✅ streak の確定ルール：q_code_final を最優先（切替瞬間の巻き戻り防止）
    // ✅ FIX: ただし DBで確定できている場合（qtuFrom が db:*）はここで壊さない
    const qFinal =
      typeof q_code_final === 'string' && q_code_final.trim().length ? q_code_final.trim() : null;

    const isDbConfirmed = typeof qtuFrom === 'string' && qtuFrom.startsWith('db:');

    if (qFinal && !isDbConfirmed) {
      // streakQ は必ず qFinal に揃える
      const prevStreakQ = streakQ;
      streakQ = qFinal;

      // qtu / seed が別Qの streak を持ってきた場合、連続は 1 から
      if (prevStreakQ && prevStreakQ !== qFinal) {
        streakLenNum = 1;
      } else if (!prevStreakQ) {
        streakLenNum = Math.max(1, Number(streakLenNum || 0));
      }
    }

    /* =========================================================
     * (K) insert（候補テーブル順に試す）
     * - ✅ iros / public.iros のみ
     * - ✅ FIX: streak_len は text カラムなので string で入れる
     * ========================================================= */
    for (const table of ['iros_messages', 'public.iros_messages'] as const) {
      const tIns = process.hrtime.bigint();

      const row = {
        ...baseRowWithQ,
        depth_stage: depth_stage_final,
        intent_layer: intent_layer_final,
        streak_q: streakQ,
        streak_len: streakLenNum != null ? String(streakLenNum) : null, // ✅ textへ統一
        qtu_from: qtuFrom,
        meta,
      };

      try {
        const { data, error } = await (supabase as any).from(table).insert([row]).select('id,created_at').single();

        console.log('[IROS/messages][POST] insert tried', {
          table,
          ms: msSince(tIns),
          ok: !error,
          hasData: !!data,
          q_code: row?.q_code ?? null,
          depth_stage: row?.depth_stage ?? null,
          intent_layer: row?.intent_layer ?? null,
          streak_q: row?.streak_q ?? null,
          streak_len: row?.streak_len ?? null,
          qtu_from: row?.qtu_from ?? null,
          err: error ? JSON.stringify(error) : null,
        });

        if (!error && data) {
          inserted = { id: (data as any).id, created_at: (data as any).created_at ?? nowIso };
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

    console.log('[IROS/messages][POST] nextStep strip', {
      rawText,
      choiceId,
      cleanText,
      finalText,
    });

    console.log('[IROS/messages][POST] done', { ms: msSince(t0) });

    if (!inserted) {
      console.error('[IROS/messages][POST] insert failed all', { ms: msSince(t0) });
      return json(
        {
          ok: false,
          error: 'insert_failed_all_candidates',
          error_code: 'insert_failed_all_candidates',
          ms: msSince(t0),
        },
        500,
      );
    }

    return json({
      ok: true,
      message: {
        id: String(inserted.id),
        conversation_id,
        role,
        content: finalText,
        created_at: inserted.created_at,

        q_code: q_code_final,
        depth_stage: depth_stage_final,
        intent_layer: intent_layer_final,

        streak_q: streakQ,
        streak_len: streakLenNum != null ? String(streakLenNum) : null, // ✅ 応答も text に揃える
        qtu_from: qtuFrom,

        meta,
      },
    });
  } catch (e: any) {
    console.error('[IROS/messages][POST] exception', {
      ms: msSince(t0),
      message: String(e?.message ?? e),
    });
    return json(
      {
        ok: false,
        error: 'unhandled_error',
        error_code: 'unhandled_error',
        detail: String(e?.message ?? e),
        ms: msSince(t0),
      },
      500,
    );
  }
}
