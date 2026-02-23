// src/app/api/agent/iros/messages/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

import {
  extractNextStepChoiceFromText,
  findNextStepOptionById,
} from '@/lib/iros/nextStepOptions';

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

function isUuidLike(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(s || '').trim(),
  );
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

/* =========================
 * Text normalizers
 * ========================= */

function normalizeGhostWhitespace(input: string): string {
  const s = String(input ?? '');
  // U+3164: Hangul Filler (ㅤ)
  // U+200B..U+200D: ZWSP/ZWNJ/ZWJ
  // U+2060: Word Joiner
  // U+FEFF: BOM
  // U+2800: Braille blank
  const removed = s.replace(/[\u3164\u200B-\u200D\u2060\uFEFF\u2800]/g, '');
  return removed.replace(/\r\n/g, '\n').trim();
}

function isEllipsisOnly(input: string): boolean {
  const s = String(input ?? '').replace(/\s+/g, '').trim();
  if (!s) return true;
  if (/^…+$/.test(s)) return true;
  if (/^\.+$/.test(s)) return true;
  if (/^[.…]+$/.test(s)) return true;
  return false;
}

/** directives / internal tags strip (API-level) */
function stripDirectivesForApi(input: string): string {
  let s = String(input ?? '');

  // 行頭ディレクティブ（例: "@ACK ..." 等）を行ごと削除
  s = s.replace(/^\s*@[A-Z0-9_-]{2,}.*(?:\r?\n|$)/gm, '');

  // iLine検証タグ等（露出禁止）
  s = s.replace(/\[\[ILINE\]\]/g, '');
  s = s.replace(/\[\[\/ILINE\]\]/g, '');

  // 空行圧縮
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

/* =========================
 * Types / Tables
 * ========================= */

type OutMsg = {
  id: string;
  conversation_id: string; // 外部cidで返す
  role: 'user' | 'assistant';

  // ✅ 互換: 旧クライアント / jq が .text を見ることがある
  text: string;

  // ✅ 現行: 正本
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
const CONV_TABLES = ['iros_conversations', 'public.iros_conversations'] as const;

// ✅ 読み取りは view 優先（“本文 text の確定” を最優先）
const MSG_TABLES = [
  'v_iros_messages',
  'iros_messages_ui',
  'iros_messages_normalized',
  'iros_messages',
  'public.iros_messages',
] as const;

const MEM_TABLES = ['iros_memory_state', 'public.iros_memory_state'] as const;

/* =========================
 * Memory helpers
 * ========================= */

async function loadMemoryState(supabase: any, userCode: string) {
  const selectMin = [
    'intent_anchor',
    'itx_step',
    'itx_last_at',
    'itx_reason',
    'q_primary',
    'depth_stage',
    'intent_layer',
    'phase',
    'spin_loop',
    'spin_step',
    'descent_gate',
    'q_counts',
  ].join(',');

  for (const mt of MEM_TABLES) {
    try {
      const { data, error } = await supabase.from(mt).select(selectMin).eq('user_code', userCode).maybeSingle();
      if (!error && data) return data;
    } catch {
      // ignore
    }
  }
  return null;
}

function extractQTraceFromQCounts(qCounts: any): any | null {
  if (!qCounts || typeof qCounts !== 'object') return null;
  const qt = (qCounts as any).q_trace;
  if (!qt || typeof qt !== 'object') return null;
  return qt;
}

function normalizeIntentLayerFromDepth(depthStage: string | null): string | null {
  if (!depthStage) return null;
  const c = String(depthStage).trim().charAt(0).toUpperCase();
  return c === 'S' || c === 'R' || c === 'C' || c === 'I' || c === 'T' ? c : null;
}

/* =========================
 * streak: DB confirm (optional but safer)
 * ========================= */

async function computeUserStreakFromDb(args: {
  supabase: any;
  conversationIdUuid: string; // uuid
  userCode: string;
  qCodeFinal: string | null;
}): Promise<{ streak_q: string | null; streak_len: number | null; qtu_from: string | null }> {
  const { supabase, conversationIdUuid, userCode, qCodeFinal } = args;

  const qFinal = typeof qCodeFinal === 'string' ? qCodeFinal.trim() : '';
  if (!qFinal) return { streak_q: null, streak_len: null, qtu_from: null };

  for (const table of ['iros_messages', 'public.iros_messages'] as const) {
    try {
      const { data, error } = await supabase
        .from(table)
        .select('q_code, created_at')
        .eq('conversation_id', conversationIdUuid)
        .eq('user_code', userCode)
        .eq('role', 'user')
        .order('created_at', { ascending: false })
        .limit(50);

      if (error) continue;

      const rows: any[] = Array.isArray(data) ? data : [];
      let prevRun = 0;

      for (const r of rows) {
        const q = typeof r?.q_code === 'string' ? r.q_code.trim() : '';
        if (!q) continue;
        if (q === qFinal) prevRun += 1;
        else break;
      }

      return { streak_q: qFinal, streak_len: prevRun + 1, qtu_from: `db:${table}` };
    } catch {
      continue;
    }
  }

  return { streak_q: null, streak_len: null, qtu_from: null };
}

/* =========================
 * Conversation resolve
 * ========================= */

async function resolveConversationRow(supabase: ReturnType<typeof sb>, cid: string) {
  // (1) まず id.eq(cid) で試す（uuid/最小互換）
  {
    const conv = await trySelect<any>(
      supabase,
      CONV_TABLES,
      { '*': '*' },
      (q) => q.eq('id', cid).limit(1),
    );
    const row = conv.ok ? (conv as any).data?.[0] ?? null : null;
    if (row) return row;
  }

  // (2) だめなら conversation_key も試す（外部ID対応）
  try {
    const conv2 = await trySelect<any>(
      supabase,
      CONV_TABLES,
      { '*': '*' },
      (q) => q.or(`id.eq.${cid},conversation_key.eq.${cid}`).limit(1),
    );
    const row = conv2.ok ? (conv2 as any).data?.[0] ?? null : null;
    if (row) return row;
  } catch {
    // ignore
  }

  return null;
}

function resolveInternalUuid(cid: string, convRow: any): string | null {
  return (
    (isUuidLike(cid) ? String(cid).trim() : null) ||
    (isUuidLike(String(convRow?.id ?? '')) ? String(convRow.id).trim() : null) ||
    (isUuidLike(String(convRow?.uuid ?? '')) ? String(convRow.uuid).trim() : null) ||
    (isUuidLike(String(convRow?.conversation_uuid ?? '')) ? String(convRow.conversation_uuid).trim() : null) ||
    (isUuidLike(String(convRow?.internal_uuid ?? '')) ? String(convRow.internal_uuid).trim() : null)
  );
}

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
      return json(
        { ok: false, error: 'authz_throw', error_code: 'authz_throw', detail: String(e?.message ?? e), ms },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      return json({ ok: false, error: auth.error, error_code: 'authz_not_ok', ms }, status);
    }

    const userCode =
      (auth.user?.user_code as string) || (auth.user?.uid as string) || (auth.userCode as string) || '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing', error_code: 'user_code_missing' }, 400);

    // (B) Params
    const cid =
      req.nextUrl.searchParams.get('conversation_id') ||
      req.nextUrl.searchParams.get('conversationId') ||
      req.nextUrl.searchParams.get('conv_id') ||   // ✅ alias (curl/legacy)
      req.nextUrl.searchParams.get('convId') ||    // ✅ alias
      req.nextUrl.searchParams.get('id') ||
      '';
    if (!cid) {
      return json({ ok: false, error: 'missing_conversation_id', error_code: 'missing_conversation_id' }, 400);
    }

    const limitRaw = req.nextUrl.searchParams.get('limit');
    const limit = (() => {
      if (!limitRaw) return 200;
      const n = Number(limitRaw);
      if (!Number.isFinite(n) || n <= 0) return 200;
      return Math.min(n, 500);
    })();

    const includeMetaParam =
      req.nextUrl.searchParams.get('include_meta') ?? req.nextUrl.searchParams.get('includeMeta');

    // ✅ デフォルトは「常に meta なし」：必要なときだけ include_meta=1 を明示
    const includeMeta = includeMetaParam != null ? asBool(includeMetaParam) : false;

    const supabase = sb();

    // (C) Conversation owner check (existence hidden)
    const convRow = await resolveConversationRow(supabase, cid);

    if (!convRow) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'conversation_not_found' }, 200);
    }

    const owner = String(convRow.user_code ?? '');
    if (owner && owner !== userCode) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'forbidden_owner_mismatch' }, 200);
    }

    // (C2) Resolve internal uuid used by iros_messages.conversation_id
    const convUuid = resolveInternalUuid(cid, convRow);
    if (!convUuid) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'no_conversation_uuid_mapping' }, 200);
    }

    // (D) Messages select (use convUuid)
    const columnsForV = includeMeta
      ? [
          'message_id',
          'conversation_id',
          'user_code',
          'role',
          'text',
          'created_at',
          'q_primary',
          'color',
          'depth_stage',
          'intent_layer',
          'meta',
        ].join(',')
      : ['message_id', 'conversation_id', 'user_code', 'role', 'text', 'created_at', 'q_primary', 'color', 'depth_stage', 'intent_layer'].join(',');

    const columnsForUI = includeMeta
      ? ['id', 'conversation_id', 'user_code', 'role', 'text', 'created_at', 'q_code', 'color', 'depth_stage', 'intent_layer', 'meta'].join(',')
      : ['id', 'conversation_id', 'user_code', 'role', 'text', 'created_at', 'q_code', 'color', 'depth_stage', 'intent_layer'].join(',');

    const columnsForNormalized = includeMeta
      ? ['id', 'conversation_id', 'user_code', 'role', 'content', 'created_at', 'q_code', 'color', 'depth_stage', 'intent_layer', 'meta'].join(',')
      : ['id', 'conversation_id', 'user_code', 'role', 'content', 'created_at', 'q_code', 'color', 'depth_stage', 'intent_layer'].join(',');

    const columnsForTable = includeMeta
      ? ['id', 'conversation_id', 'user_code', 'role', 'content', 'text', 'q_code', 'color', 'depth_stage', 'intent_layer', 'created_at', 'meta'].join(',')
      : ['id', 'conversation_id', 'user_code', 'role', 'content', 'text', 'q_code', 'color', 'depth_stage', 'intent_layer', 'created_at'].join(',');

    const columnsByTable: Record<string, string> = {
      v_iros_messages: columnsForV,
      iros_messages_ui: columnsForUI,
      iros_messages_normalized: columnsForNormalized,
      iros_messages: columnsForTable,
      'public.iros_messages': columnsForTable,
      '*': columnsForTable,
    };

    const res = await trySelect<any>(supabase, MSG_TABLES, columnsByTable, (q) =>
      q.eq('conversation_id', convUuid).order('created_at', { ascending: false }).limit(limit),
    );

    if (!res.ok) {
      return json(
        { ok: false, error: 'messages_select_failed', error_code: 'messages_select_failed', messages: [], llm_messages: [] },
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
      const idVal = m.message_id ?? m.id ?? '';
      const rawContent = (m.text ?? m.content ?? '').toString();
      const contentVal = stripDirectivesForApi(rawContent);
      const qAny = (m.q_primary ?? m.q_code ?? null) as any;

      return {
        id: String(idVal),
        conversation_id: String(cid), // 外部cidで返す
        role: m.role === 'assistant' ? 'assistant' : 'user',

        // ✅ 互換: 旧クライアント / jq が .text を見る
        text: contentVal,

        // ✅ 正本
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

    const llm_messages: LlmMsg[] = messages
      .slice(-llmLimit)
      .map((m) => ({ role: m.role, content: m.content }));

    return json({ ok: true, messages, llm_messages, includeMeta, source: (res as any).table }, 200);
  } catch (e: any) {
    return json(
      { ok: false, error: 'unhandled_error', error_code: 'unhandled_error', detail: String(e?.message ?? e), ms: msSince(t0) },
      500,
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
      return json(
        { ok: false, error: 'authz_throw', error_code: 'authz_throw', detail: String(e?.message ?? e), ms },
        isUpstreamTimeout(e) ? 504 : 401,
      );
    }

    if (!auth.ok) {
      const ms = msSince(t0);
      const status = isUpstreamTimeout(auth) ? 504 : auth.status || 401;
      return json({ ok: false, error: auth.error, error_code: 'authz_not_ok', ms }, status);
    }

    const userCode =
      (auth.user?.user_code as string) || (auth.user?.uid as string) || (auth.userCode as string) || '';
    if (!userCode) return json({ ok: false, error: 'user_code_missing', error_code: 'user_code_missing' }, 400);

    // (B) Body
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const reqId: string =
      (typeof body?.reqId === 'string' && body.reqId.trim()) ||
      (typeof body?.requestId === 'string' && body.requestId.trim()) ||
      (req.headers.get('x-request-id')?.trim() || '') ||
      crypto.randomUUID();

    const cidExternal: string = String(body?.conversation_id || body?.conversationId || body?.id || '').trim();
    if (!cidExternal) {
      return json({ ok: false, error: 'missing_conversation_id', error_code: 'missing_conversation_id', reqId }, 400);
    }

    const role: 'user' | 'assistant' =
      String(body?.role ?? '').toLowerCase() === 'assistant' ? 'assistant' : 'user';

    const rawText: string = String(body?.text ?? body?.content ?? '');

    // ✅ single-writer: /messages は user だけ保存。assistant は絶対保存しない。
    if (role === 'assistant') {
      return json({ ok: true, skipped: true, reason: 'ASSISTANT_ROLE_NEVER_PERSISTED_SINGLE_WRITER', reqId }, 200);
    }

    if (!rawText || !String(rawText).trim()) {
      return json({ ok: false, error: 'text_empty', error_code: 'text_empty', reqId }, 400);
    }

    const supabase = sb();

    // (C) Conversation owner check (existence hidden)
    const convRow = await resolveConversationRow(supabase, cidExternal);

    if (!convRow) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'conversation_not_found', reqId }, 200);
    }

    const owner = String(convRow.user_code ?? '');
    if (owner && owner !== userCode) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'forbidden_owner_mismatch', reqId }, 200);
    }

    const convUuid = resolveInternalUuid(cidExternal, convRow);
    if (!convUuid) {
      return json({ ok: true, messages: [], llm_messages: [], note: 'no_conversation_uuid_mapping', reqId }, 200);
    }

    // (D) NextStep + text normalize（choiceIdは使用しない）
    const extracted = extractNextStepChoiceFromText(rawText);

    // NextStep廃止方針：
    // - body/meta/extra 由来の choiceId はすべて無視
    // - tag strip（cleanText）のみ適用
    const choiceId: string | null = null;

    const cleanTextAfterTagStrip = normalizeGhostWhitespace(extracted.cleanText);
    const rawTextNorm = normalizeGhostWhitespace(rawText);

    let finalText = (cleanTextAfterTagStrip.length ? cleanTextAfterTagStrip : rawTextNorm).trim();
    if (isEllipsisOnly(finalText)) finalText = '';
    if (!finalText) return json({ ok: false, error: 'text_empty', error_code: 'text_empty', reqId }, 400);

    // (E) meta build + sanitize（NextStep関連は付与しない）
    const metaRaw = body?.meta ?? null;
    const baseMetaRaw = metaRaw && typeof metaRaw === 'object' && !Array.isArray(metaRaw) ? metaRaw : {};
    const baseExtraRaw =
      baseMetaRaw.extra && typeof baseMetaRaw.extra === 'object' && !Array.isArray(baseMetaRaw.extra)
        ? baseMetaRaw.extra
        : {};

    const metaAugRaw = {
      ...baseMetaRaw,
      extra: {
        ...baseExtraRaw,
        // NextStep関連は常にnull
        nextStepChoiceId: null,
        nextStepPicked: null,
        nextStepPickedMeta: null,
      },
    };
    const metaSanitized = sanitizeJsonDeep(metaAugRaw);
    const metaBase =
      metaSanitized && typeof metaSanitized === 'object' && !Array.isArray(metaSanitized) ? metaSanitized : {};

    // memory_state (single read)
    const msRow = await loadMemoryState(supabase as any, userCode);

    const hasAnchorAlready =
      metaBase.intent_anchor != null ||
      (typeof metaBase.intent_anchor_key === 'string' && metaBase.intent_anchor_key.trim()) ||
      (typeof metaBase.anchor_key === 'string' && metaBase.anchor_key.trim());

    const hasItxAlready =
      (typeof metaBase.itx_step === 'string' && metaBase.itx_step.trim()) ||
      metaBase.itx_last_at != null ||
      (typeof metaBase.itx_reason === 'string' && metaBase.itx_reason.trim());

    const anchorKeyFromState =
      msRow?.intent_anchor && (msRow.intent_anchor as any)?.key ? (msRow.intent_anchor as any).key : null;

    const metaFilled = {
      ...metaBase,
      ...(msRow && !hasAnchorAlready
        ? { intent_anchor: msRow.intent_anchor ?? null, intent_anchor_key: anchorKeyFromState, anchor_key: anchorKeyFromState }
        : {}),
      ...(msRow && !hasItxAlready
        ? { itx_step: msRow.itx_step ?? null, itx_last_at: msRow.itx_last_at ?? null, itx_reason: msRow.itx_reason ?? null }
        : {}),
    };

    // (F) q/depth/intent pick (body first)
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
      toNonEmptyTrimmedString(body?.intent_layer) ??
      toNonEmptyTrimmedString(body?.intentLayer) ??
      null;

    const q_code_from_meta_raw =
      pickMetaValue(metaFilled as any, ['qCode', 'q_code', 'qPrimary', 'q_code_primary']) ??
      pickMetaValue(metaAugRaw as any, ['qCode', 'q_code', 'qPrimary', 'q_code_primary']) ??
      null;

    const depth_stage_from_meta_raw =
      pickMetaValue(metaFilled as any, ['depth', 'depthStage', 'depth_stage']) ??
      pickMetaValue(metaAugRaw as any, ['depth', 'depthStage', 'depth_stage']) ??
      null;

    const intent_layer_from_meta_raw =
      pickMetaValue(metaFilled as any, ['intentLayer', 'intent_layer']) ??
      pickMetaValue(metaAugRaw as any, ['intentLayer', 'intent_layer']) ??
      null;

    const q_code_from_meta =
      q_code_from_meta_raw && /^Q[1-5]$/.test(String(q_code_from_meta_raw)) ? String(q_code_from_meta_raw) : null;

    const depth_stage_from_meta =
      depth_stage_from_meta_raw && /^[SRCIT][0-3]$/.test(String(depth_stage_from_meta_raw))
        ? String(depth_stage_from_meta_raw)
        : null;

    const intent_layer_from_meta =
      intent_layer_from_meta_raw && /^[SRCIT]$/.test(String(intent_layer_from_meta_raw))
        ? String(intent_layer_from_meta_raw)
        : null;

    // memory fallback (last resort)
    const q_from_state = msRow ? (toNonEmptyTrimmedString(msRow.q_primary) ?? null) : null;
    const depth_from_state = msRow ? (toNonEmptyTrimmedString(msRow.depth_stage) ?? null) : null;
    const layer_from_state = msRow ? (toNonEmptyTrimmedString(msRow.intent_layer) ?? null) : null;

    const q_code_final = q_code_from_body ?? q_code_from_meta ?? q_from_state ?? null;
    const depth_stage_final = depth_stage_from_body ?? depth_stage_from_meta ?? depth_from_state ?? null;

    const intent_layer_from_depth = normalizeIntentLayerFromDepth(depth_stage_final);
    const intent_layer_final =
      intent_layer_from_depth ?? (intent_layer_from_body ?? intent_layer_from_meta ?? layer_from_state ?? null);

    // (G) streak (metaFilled → state → db confirm)
    const qtu: any = (metaFilled as any)?.qTraceUpdated ?? (metaFilled as any)?.qTrace ?? null;
    const qTraceFromCounts = msRow ? extractQTraceFromQCounts(msRow.q_counts) : null;

    const streakQ_from_qtu =
      typeof qtu?.streakQ === 'string' && qtu.streakQ.trim().length ? qtu.streakQ.trim() : null;
    const streakLen_from_qtu =
      typeof qtu?.streakLength === 'number' && Number.isFinite(qtu.streakLength)
        ? Math.max(0, Math.floor(qtu.streakLength))
        : toIntOrNull(qtu?.streakLength);

    const streakQ_from_state =
      typeof qTraceFromCounts?.streakQ === 'string' && qTraceFromCounts.streakQ.trim().length
        ? qTraceFromCounts.streakQ.trim()
        : null;

    const streakLen_from_state = (() => {
      const n = toIntOrNull(qTraceFromCounts?.streakLength);
      return n != null ? n : null;
    })();

    let streakQ: string | null = streakQ_from_qtu ?? streakQ_from_state ?? q_code_final ?? null;

    let streakLenNum: number | null =
      (streakLen_from_qtu != null ? streakLen_from_qtu : null) ??
      (streakLen_from_state != null ? streakLen_from_state : null) ??
      (q_code_final ? 1 : null);

    let qtuFrom: string | null =
      (typeof qtu?.from === 'string' && qtu.from.trim().length ? qtu.from.trim() : null) ??
      ((metaFilled as any)?.qTraceUpdated ? 'qTraceUpdated' : qtu ? 'qTrace' : qTraceFromCounts ? 'q_counts.q_trace' : null);

    // DB confirm (bump only)
    {
      const db = await computeUserStreakFromDb({
        supabase,
        conversationIdUuid: convUuid,
        userCode,
        qCodeFinal: q_code_final,
      });

      if (db.streak_q && db.streak_len != null) {
        const cur = typeof streakLenNum === 'number' && Number.isFinite(streakLenNum) ? streakLenNum : 0;
        if (db.streak_len > cur) {
          streakQ = db.streak_q;
          streakLenNum = db.streak_len;
          qtuFrom = db.qtu_from ?? qtuFrom;
        }
      }
    }

    // Hard invariants
    const qFinal = typeof q_code_final === 'string' && q_code_final.trim().length ? q_code_final.trim() : null;

    if (!qFinal) {
      streakQ = null;
      streakLenNum = null;
    } else {
      const prevStreakQ = streakQ;
      streakQ = qFinal;

      if (prevStreakQ && prevStreakQ !== qFinal) streakLenNum = 1;

      const cur = typeof streakLenNum === 'number' && Number.isFinite(streakLenNum) ? streakLenNum : 0;
      if (cur < 1) streakLenNum = 1;
    }

    // (H) insert
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    const row = {
      conversation_id: convUuid, // ✅ DBのuuid列に入れるのは常にuuid
      user_code: userCode,
      role,
      content: finalText,
      text: finalText,
      created_at: nowIso,
      ts: nowTs,

      q_code: q_code_final,
      depth_stage: depth_stage_final,
      intent_layer: intent_layer_final,

      streak_q: streakQ,
      streak_len: streakLenNum != null ? String(streakLenNum) : null, // text
      qtu_from: qtuFrom,
      meta: metaFilled,
    };

    let inserted: { id: string | number; created_at: string | null } | null = null;

    for (const table of ['iros_messages', 'public.iros_messages'] as const) {
      try {
        // ✅ まず insert 成功を優先（returning が取れなくても落とさない）
        const ins = await (supabase as any).from(table).insert([row]);
        if (ins?.error) continue;

        // ✅ returning を“取れたらラッキー”で試す（0行でもOK）
        const sel = await (supabase as any)
          .from(table)
          .select('id,created_at')
          .eq('conversation_id', convUuid)
          .eq('user_code', userCode)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!sel?.error && sel?.data) {
          inserted = { id: (sel.data as any).id, created_at: (sel.data as any).created_at ?? nowIso };
        } else {
          // ✅ select が取れない環境でも insert は成功しているので最低限返す
          inserted = { id: String(nowTs), created_at: nowIso };
        }

        break;
      } catch {
        // ignore
      }
    }

    if (!inserted) {
      return json(
        { ok: false, error: 'insert_failed_all_candidates', error_code: 'insert_failed_all_candidates', ms: msSince(t0), reqId },
        500,
      );
    }

    return json({
      ok: true,
      reqId,
      message: {
        id: String(inserted.id),
        conversation_id: cidExternal, // ✅ 外部cidで返す
        role,
        content: finalText,
        created_at: inserted.created_at,

        q_code: q_code_final,
        depth_stage: depth_stage_final,
        intent_layer: intent_layer_final,

        streak_q: streakQ,
        streak_len: streakLenNum != null ? String(streakLenNum) : null,
        qtu_from: qtuFrom,

        meta: metaFilled,
      },
    });

  } catch (e: any) {
    return json(
      { ok: false, error: 'unhandled_error', error_code: 'unhandled_error', detail: String(e?.message ?? e), ms: msSince(t0) },
      500,
    );
  }
}
