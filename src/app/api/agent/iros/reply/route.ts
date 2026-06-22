import { enrichRelationshipIdentity } from '@/lib/iros/relationshipIdentity';
import { NextRequest, NextResponse } from 'next/server';
import { buildPreSeedFlowDirective, resolvePreSeedDecision } from '@/lib/iros/server/preseed';
import { callPreSeedDiagnosisWriter } from '@/lib/iros/server/preseed/callPreSeedDiagnosisWriter';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';

import { loadIrosUserProfile } from '@/lib/iros/server/loadUserProfile';
import { saveIrosTrainingSample } from '@/lib/iros/server/saveTrainingSample';
import { saveFlowPatternSnapshot } from '@/lib/iros/flowPattern/saveFlowPatternSnapshot';
import { loadSimilarFlowSnapshots } from '@/lib/iros/flowPattern/loadSimilarFlowSnapshots';
import { buildSimilarFlowSeed } from '@/lib/iros/flowPattern/buildSimilarFlowSeed';
import { loadFeedbackSummary } from '@/lib/iros/server/loadFeedbackSummary';
import { handleIrosReply, type HandleIrosReplyOutput } from '@/lib/iros/server/handleIrosReply';

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

import { attachNextStepMeta, extractNextStepChoiceFromText, findNextStepOptionById } from '@/lib/iros/nextStepOptions';
import { ensureIrosConversationUuid } from '@/lib/iros/server/ensureIrosConversationUuid';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { saveIrDiagnosisResult } from '@/lib/iros/memory/saveIrDiagnosisResult';
import { capturePersonFactFromConversation } from '@/lib/iros/personFactCapture';
import { captureRelationshipContextFromConversation } from '@/lib/iros/relationshipContextCapture';
import { extractPendingOfferFromAssistantText } from '@/lib/iros/memory/continuityOffer.extractor';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { decideExpressionLane } from '@/lib/iros/expression/decideExpressionLane';
import { normalizeIrosStyleFinal } from '@/lib/iros/language/normalizeIrosStyleFinal';
import { chatComplete } from '@/lib/llm/chatComplete';

import { loadIrosMemoryState } from '@/lib/iros/memoryState';
import { applyRenderEngineIfEnabled } from './_impl/applyRenderEngineIfEnabled';
import { applySoftExpression } from '@/lib/iros/language/softExpression';

import {
  pickUserCode,
  isEffectivelyEmptyText,
  sanitizeFinalContent,
  normalizeMetaLevels,
} from './_helpers';

import { pickText } from './_impl/utils';

// =========================================================
// CORS
// =========================================================
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-user-code, x-credit-cost, x-trace-id',
} as const;

// =========================================================
// Credit defaults
// =========================================================

// 既定：1往復 = 5pt（ENVで上書き可）
const CHAT_CREDIT_AMOUNT = Number(process.env.IROS_CHAT_CREDIT_AMOUNT ?? 5);

// 残高しきい値（ENVで上書き可）
const LOW_BALANCE_THRESHOLD = Number(process.env.IROS_LOW_BALANCE_THRESHOLD ?? 10);

// 1: 課金authorizeをバイパス（Preview検証用）
const CREDITS_BYPASS = (process.env.CREDITS_BYPASS || '0') === '1';

// =========================================================
// Persist policy（single-writer）
// =========================================================

// ✅ single-writer policy（このrouteは assistant 保存だけを担当）
const PERSIST_POLICY = 'REPLY_SINGLE_WRITER' as const;

// =========================================================
// Supabase (service-role)
// =========================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing');
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing (service-role required)');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  global: {
    fetch: async (input: any, init?: any) => {
      const controller = new AbortController();

      // ✅ 20s だと「DBのstatement_timeout等の本当の原因」を受け取る前に abort してしまう
      // - デフォルト 60s
      // - env で上書き可: SUPABASE_FETCH_TIMEOUT_MS
      const timeoutMs = Math.max(
        5_000,
        Number(process.env.SUPABASE_FETCH_TIMEOUT_MS ?? '60000') || 60_000,
      );

      const t = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(input, { ...(init ?? {}), signal: controller.signal });

        const status = res.status;
        const ct = String(res.headers.get('content-type') ?? '').toLowerCase();

        const looksLikeHtml = ct.includes('text/html') || ct.includes('application/xhtml+xml');
        const isUpstreamBad = status >= 520;

        if (!res.ok && (looksLikeHtml || isUpstreamBad)) {
          let head = '';
          try {
            const txt = await res.text();
            head = txt.slice(0, 400); // ✅ ログ汚染防止（先頭だけ）
          } catch {}

          const cfRay =
            res.headers.get('cf-ray') ||
            res.headers.get('x-amz-cf-id') ||
            res.headers.get('x-request-id') ||
            '';

          throw new Error(
            `[SUPABASE_UPSTREAM_BAD] status=${status} ct=${ct || '(none)'} cfRay=${cfRay || '(none)'} head=${
              head || '(empty)'
            }`,
          );
        }

        return res;
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new Error(`[SUPABASE_FETCH_TIMEOUT] ${timeoutMs}ms`);
        throw e;
      } finally {
        clearTimeout(t);
      }
    },
  },
});

// =========================================================
// OPTIONS
// =========================================================
export async function OPTIONS(req: NextRequest) {
  const traceId = makeEarlyTraceId(req);
  return new NextResponse(null, { status: 204, headers: withTrace(CORS_HEADERS, traceId) });
}

function sanitizeIrosReplyMetaForClient(metaInput: any): any {
  if (!metaInput || typeof metaInput !== 'object') return null;

  const meta = metaInput as Record<string, any>;
  const extra =
    meta.extra && typeof meta.extra === 'object'
      ? (meta.extra as Record<string, any>)
      : {};

  const pick = (obj: Record<string, any>, keys: string[]) => {
    const out: Record<string, any> = {};
    for (const key of keys) {
      if (obj[key] !== undefined) out[key] = obj[key];
    }
    return out;
  };

  const clientMeta: Record<string, any> = pick(meta, [
    'style',
    'depth',
    'depthStage',
    'depth_stage',
    'intentLayer',
    'phase',
    'spinLoop',
    'spinStep',
    'descentGate',
    'intent_anchor',
    'intent_anchor_key',
    'rotationState',
    'selfAcceptance',
    'yLevel',
    'hLevel',
    'inputKind',
    'framePlan',
  ]);

  const clientExtra: Record<string, any> = pick(extra, [
    'uiCue',
    'e_turn',
    'polarity',
    'mirrorConfidence',
    'exprDecision',
    'finalTextPolicy',
    'speechAct',
    'speechActReason',
    'speechActConfidence',
  ]);

  if (Object.keys(clientExtra).length > 0) {
    clientMeta.extra = clientExtra;
  }

  return clientMeta;
}

// =========================================================
// Local helpers
// =========================================================

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type IrosReplyBody = {
  conversationId?: unknown;
  conversation_id?: unknown;

  text?: unknown;

  hintText?: unknown;
  modeHintText?: unknown;
  modeHint?: unknown;

  style?: unknown;
  styleHint?: unknown;


  tenant_id?: unknown;
  tenantId?: unknown;

  userCode?: unknown;
  agent?: unknown;

  history?: unknown;

  cost?: unknown;
  extra?: unknown;
};
function withTrace(headers: Record<string, string>, traceId: string) {
  return { ...headers, 'x-trace-id': String(traceId) };
}
function makeEarlyTraceId(req: NextRequest) {
  const fromHeader = String(req.headers.get('x-trace-id') ?? '').trim();
  if (fromHeader) return fromHeader;

  // ✅ fallback（環境差を消すため randomUUID は使わない）
  return `trace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function makeTraceId(req: NextRequest, extraReq: any | null, fallbackEarly: string) {
  const fromHeader = String(req.headers.get('x-trace-id') ?? '').trim();
  if (fromHeader) return fromHeader;

  // extraReq は body.extra を想定（互換で trace_id も見る）
  const fromExtra = String(extraReq?.traceId ?? extraReq?.trace_id ?? '').trim();
  if (fromExtra) return fromExtra;

  return fallbackEarly;
}

function stripInternalLines(s0: string) {
  const s = String(s0 ?? '').replace(/\r\n/g, '\n');

  const lines = s.split('\n').filter((ln) => {
    const t = ln.trim();

    // ✅ 空行は保持する
    if (!t) return true;

    // ✅ 内部 directive 行だけ落とす
    if (t.startsWith('@OBS')) return false;
    if (t.startsWith('@SHIFT')) return false;
    if (t.startsWith('@NEXT')) return false;
    if (t.startsWith('@SAFE')) return false;
    if (t.startsWith('@DRAFT')) return false;
    if (t.startsWith('@SEED_TEXT')) return false;
    if (t.startsWith('INTERNAL PACK')) return false;

    return true;
  });

  // ✅ 先頭末尾だけ余分な空行を落とす（段落間の空行は残す）
  return lines.join('\n').replace(/^\n+|\n+$/g, '');
}
function blocksToText(bs: any[]) {
  const parts = bs
    .map((b) => {
      if (typeof b === 'string') return b.trimEnd();
      return String(b?.text ?? b?.content ?? b?.value ?? b?.body ?? '').trimEnd();
    })
    .filter((s) => String(s).trim().length > 0);

  return parts.join('\n\n').trimEnd();
}

// =========================================================
// POST
// =========================================================
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  let auth: any = null;

  // ✅ 早期returnでも必ず traceId を返す（body未読でも使える）
  const traceIdEarly = makeEarlyTraceId(req);

  try {
// =========================================================
// PERF timers（dev only）
// =========================================================
const PERF_ON =
  process.env.NODE_ENV !== 'production' &&
  String(process.env.IROS_PERF_LOG ?? '').trim() !== '0';

const t0 = Date.now();
const laps: Array<{ k: string; ms: number }> = [];
const lap = (k: string) => {
  if (!PERF_ON) return;
  const ms = Date.now() - t0;
  laps.push({ k, ms });
};
const lapWarn = (k: string, msCost: number, extra?: any) => {
  if (!PERF_ON) return;
  if (msCost >= 1000) console.warn('[IROS/PERF][SLOW]', { k, ms: msCost, ...(extra ?? {}) });
  else console.info('[IROS/PERF]', { k, ms: msCost, ...(extra ?? {}) });
};

// -------------------------------------------------------
// 1) body
// -------------------------------------------------------
const body = (await req.json().catch(() => ({} as any))) as IrosReplyBody;

// ------------------------------
// Request meta passthrough (debug-safe)
// - 入力 meta.extra を後段の正規化/上書きから守るために退避
// ------------------------------
let reqMetaRaw: any = (body as any)?.meta ?? null;
(reqMetaRaw ??= {}).longTermMemoryNoteText =
  reqMetaRaw?.longTermMemoryNoteText ??
  reqMetaRaw?.extra?.longTermMemoryNoteText ??
  null;
const reqSpeechActRaw =
  (reqMetaRaw as any)?.extra?.speechAct ??
  (reqMetaRaw as any)?.speechAct ??
  null;

// ✅ ここで先に extraReq / traceId を確定（REQ_META と TRACE を一致させる）
const extraReq0: Record<string, any> | undefined =
  (body as any)?.extra && typeof (body as any).extra === 'object'
    ? ((body as any).extra as Record<string, any>)
    : undefined;

// 互換：body直下 traceId / trace_id も吸収
const traceIdFromBody = String((body as any)?.traceId ?? (body as any)?.trace_id ?? '').trim();

// 互換：meta 側 traceId も吸収（meta が載るクライアント用）
const traceIdFromMeta = String(
  (reqMetaRaw as any)?.traceId ??
    (reqMetaRaw as any)?.extra?.traceId ??
    (reqMetaRaw as any)?.extra?.trace_id ??
    '',
).trim();

// makeTraceId は extraReq.traceId/trace_id を見るので、ここで寄せる
const extraReq: Record<string, any> | undefined = {
  ...(extraReq0 ?? {}),
  ...(traceIdFromBody ? { traceId: traceIdFromBody } : null),
  ...(!traceIdFromBody && traceIdFromMeta ? { traceId: traceIdFromMeta } : null),
};

// traceIdEarly は try の前で makeEarlyTraceId(req) されている前提
const traceId = makeTraceId(req, extraReq ?? null, traceIdEarly);

console.info('[IROS/SPEECH_EARLY_RETURN][REQ_META]', {
  // ✅ 正本（TRACE と同じ）
  traceId_used: String(traceId ?? ''),
  // 参考：body直下の traceId（古いクライアント/直指定の検出用）
  traceId_req: String((body as any)?.traceId ?? ''),
  // 参考：meta 側（もし載っていれば）
  traceId_meta:
    String((reqMetaRaw as any)?.traceId ?? '') ||
    String((reqMetaRaw as any)?.extra?.traceId ?? '') ||
    '',
  conversationId: String((body as any)?.conversationId ?? ''),
  hasReqMeta: !!reqMetaRaw,
  reqSpeechAct: reqSpeechActRaw ?? null,
  reqExtraKeys: (reqMetaRaw as any)?.extra ? Object.keys((reqMetaRaw as any).extra).slice(0, 30) : [],
});

const conversationKeyRaw =
  typeof body?.conversationId === 'string'
    ? body.conversationId
    : typeof body?.conversation_id === 'string'
      ? body.conversation_id
      : undefined;

const conversationKey =
  conversationKeyRaw && String(conversationKeyRaw).trim()
    ? String(conversationKeyRaw).trim()
    : undefined;

const text = typeof body?.text === 'string' ? body.text : (body?.text as any);
const hintText: string | undefined = (body as any)?.hintText ?? (body as any)?.modeHintText;
const modeHintInput: string | undefined = (body as any)?.modeHint;

// ✅ userCodeHint は TRACE ログより前で必ず定義
const userCodeHint =
  String(req.headers.get('x-user-code') ?? '').trim() ||
  (typeof (body as any)?.userCode === 'string' ? (body as any).userCode.trim() : '') ||
  '';

console.info('[IROS/pipe][TRACE]', {
  traceId,
  conversationKey: conversationKey ?? null,
  conversationId: null, // auth前・uuid未解決なので常に null
  userCode: userCodeHint || null,
  modeHint: modeHintInput ?? null,
  hasHeaderUserCode: !!req.headers.get('x-user-code'),
  devBypass: process.env.IROS_DEV_BYPASS_AUTH === '1',
});

const chatHistory: unknown[] | undefined = Array.isArray((body as any)?.history)
  ? ((body as any).history as unknown[])
  : undefined;

const styleInput: string | undefined =
  typeof (body as any)?.style === 'string'
    ? (body as any).style
    : typeof (body as any)?.styleHint === 'string'
      ? (body as any).styleHint
      : undefined;


    // -------------------------------------------------------
    // 2) auth
    // -------------------------------------------------------
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1';

    // ✅ header優先（従来どおり）
    const hUserCode = String(req.headers.get('x-user-code') ?? '').trim();
    const bypassUserCodeFromHeader = hUserCode.length > 0 ? hUserCode : null;

    // ✅ 開発だけ：headerが無い場合のフォールバック
    const allowDevFallback = DEV_BYPASS && process.env.NODE_ENV !== 'production';

    if (DEV_BYPASS && bypassUserCodeFromHeader) {
      auth = { ok: true, userCode: bypassUserCodeFromHeader, uid: 'dev-bypass' };
    } else if (allowDevFallback) {
      const bodyAny = (body ?? {}) as any;
      const bypassUserCodeFromBody =
        typeof bodyAny?.userCode === 'string' && bodyAny.userCode.trim().length > 0 ? bodyAny.userCode.trim() : null;

      const fallbackUserCode = String(process.env.IROS_DEV_BYPASS_USER_CODE ?? '669933').trim();
      const chosen = bypassUserCodeFromBody ?? fallbackUserCode;
      auth = { ok: true, userCode: chosen, uid: 'dev-bypass' };
    } else {
      auth = await verifyFirebaseAndAuthorize(req);
      if (!auth?.ok) {
        return NextResponse.json(
          { ok: false, error: 'unauthorized' },
          { status: 401, headers: withTrace(CORS_HEADERS, traceId) },
        );
      }
    }

    // ✅ この時点では conversationId(uuid) はまだ解決していないので uuid check しない
    if (!conversationKey || !text) {
      return NextResponse.json(
        { ok: false, error: 'bad_request', detail: 'conversationId(conversationKey) and text are required' },
        { status: 400, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }

    // -------------------------------------------------------
    // 3) ids（auth優先）
    // -------------------------------------------------------
    const userCodeFromAuth =
      typeof (auth as any)?.userCode === 'string' && String((auth as any).userCode).trim().length > 0
        ? String((auth as any).userCode).trim()
        : null;

    const userCode = userCodeFromAuth ?? pickUserCode(req, auth);

    if (!userCode) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized_user_code_missing' },
        { status: 401, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }

    const tenantId: string =
      typeof (body as any)?.tenant_id === 'string' && (body as any).tenant_id.trim().length > 0
        ? (body as any).tenant_id.trim()
        : typeof (body as any)?.tenantId === 'string' && (body as any).tenantId.trim().length > 0
          ? (body as any).tenantId.trim()
          : 'default';

    // -------------------------------------------------------
    // 4) mode / rememberScope
    // -------------------------------------------------------
    const mode = resolveModeHintFromText({ modeHint: modeHintInput, hintText, text: String(text ?? '') });
    const rememberScope: RememberScopeKind | null = resolveRememberScope({
      modeHint: modeHintInput,
      hintText,
      text: String(text ?? ''),
    });

    // -------------------------------------------------------
    // 5) conversationKey（外部キー）→ conversationId（内部uuid）
    // -------------------------------------------------------
    //
    // ✅ uuid形式の key は「内部idとしてのみ扱う」
    // - 存在しない uuid を conversation_key として ensure して “別会話” を作るのを禁止する
    //
    let conversationId: string | undefined;

    if (UUID_RE.test(conversationKey)) {
      const { data: hit, error: hitErr } = await supabase
        .from('iros_conversations')
        .select('id')
        .eq('id', conversationKey)
        .limit(1)
        .maybeSingle();

        if (hitErr) {
          console.error('[IROS/reply][conversation_uuid_lookup][ERROR]', {
            traceId,
            conversationKey,
            message: (hitErr as any)?.message ?? null,
            details: (hitErr as any)?.details ?? null,
            hint: (hitErr as any)?.hint ?? null,
            code: (hitErr as any)?.code ?? null,
          });

          return NextResponse.json(
            { ok: false, error: 'db_error', detail: 'failed to lookup conversation by uuid' },
            { status: 500, headers: withTrace(CORS_HEADERS, traceId) },
          );
        }

      if (!hit?.id) {
        return NextResponse.json(
          {
            ok: false,
            error: 'conversation_not_found',
            detail: 'uuid conversationId not found (refuse to ensure by uuid-looking key)',
          },
          { status: 404, headers: withTrace(CORS_HEADERS, traceId) },
        );
      }

      conversationId = String(hit.id);
    } else {
      conversationId = await ensureIrosConversationUuid({
        supabase,
        userCode,
        conversationKey,
        agent: typeof (body as any)?.agent === 'string' ? (body as any).agent : 'iros',
      });
    }

    if (!conversationId) {
      return NextResponse.json(
        { ok: false, error: 'bad_request', detail: 'failed to resolve internal conversationId(uuid)' },
        { status: 400, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }

    console.info('[IROS/pipe][TRACE_RESOLVED]', {
      traceId,
      conversationKey,
      conversationId,
      userCode,
    });

    // -------------------------------------------------------
    // 6) credit amount（body.cost → header → default）
    // -------------------------------------------------------
    const headerCost = req.headers.get('x-credit-cost');
    const bodyCost = (body as any)?.cost;

    const parsed =
      typeof bodyCost === 'number'
        ? bodyCost
        : typeof bodyCost === 'string'
          ? Number(bodyCost)
          : headerCost
            ? Number(headerCost)
            : NaN;

    const CREDIT_AMOUNT = Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : CHAT_CREDIT_AMOUNT;
    const creditRef = makeIrosRef(conversationId, startedAt);

    // -------------------------------------------------------
    // 7) authorize
    // -------------------------------------------------------
    const authRes = CREDITS_BYPASS
      ? { ok: true as const, status: 200, data: { bypass: true } }
      : await authorizeChat(req, userCode, CREDIT_AMOUNT, creditRef, conversationId);

    if (!authRes.ok) {
      const errCode = (authRes as any).error ?? 'credit_authorize_failed';

      const res = NextResponse.json(
        { ok: false, error: errCode, credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes } },
        { status: 402, headers: withTrace(CORS_HEADERS, traceId) },
      );

      res.headers.set('x-reason', String(errCode));
      res.headers.set('x-user-code', userCode);
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));

      return res;
    }

    // -------------------------------------------------------
    // 8) low balance warn（best-effort）
    // -------------------------------------------------------
    let lowWarn: null | { code: 'low_balance'; balance: number; threshold: number } = null;

    if (Number.isFinite(LOW_BALANCE_THRESHOLD) && LOW_BALANCE_THRESHOLD > 0) {
      const { data: balRow, error: balErr } = await supabase
        .from('users')
        .select('sofia_credit')
        .eq('user_code', userCode)
        .maybeSingle();

      if (!balErr && balRow && (balRow as any).sofia_credit != null) {
        const balance = Number((balRow as any).sofia_credit) || 0;
        if (balance < LOW_BALANCE_THRESHOLD) {
          lowWarn = { code: 'low_balance', balance, threshold: LOW_BALANCE_THRESHOLD };
        }
      }
    }

    // -------------------------------------------------------
    // 9) user profile（best-effort）
    // -------------------------------------------------------
    let userProfile: any | null = null;

    try {
      userProfile = await loadIrosUserProfile(supabase, userCode);
    } catch {
      userProfile = null;
    }
// ------------------------------
// meta merge for handleIrosReply
// - req.meta を最優先で渡す（特に meta.extra.speechAct）
// - 既存 meta がある場合は shallow+extra をマージ
// ------------------------------
const metaForIros: any = (() => {
  // 既に route 内で meta を組んでる場合に備えて拾う（無ければ null）
  const routeMetaAny: any =
    (typeof (globalThis as any).__routeMeta !== 'undefined' ? (globalThis as any).__routeMeta : null) ?? null;

  const a: any = reqMetaRaw ?? {};
  const b: any = routeMetaAny ?? {};

  const merged: any = {
    ...a,
    ...b,
    extra: {
      ...(a?.extra ?? {}),
      ...(b?.extra ?? {}),
    },
  };

  // ✅ req で speechAct 指定が来てるなら絶対に保持（null化させない）
  if (reqSpeechActRaw != null && String(reqSpeechActRaw).trim() !== '') {
    merged.extra = {
      ...(merged.extra ?? {}),
      speechAct: reqSpeechActRaw,
      speechActReason: (merged.extra?.speechActReason ?? 'from_request'),
      speechActConfidence: (merged.extra?.speechActConfidence ?? 1),
    };
  }

  return merged;
})();
    // -------------------------------------------------------
    // 10) NextStep tag strip（tagは除去するが choiceId は使わない）
    // -------------------------------------------------------
    const rawText = String(text ?? '');
    const extracted = extractNextStepChoiceFromText(rawText);

    // NextStep廃止方針：
    // - extra/body/text 由来の choiceId は現行動作に寄与しないため無視する
    // - tag strip（cleanText）は残す（ユーザー本文の純化だけ行う）
    const extractedChoiceId: string | null = null;
    const effectiveChoiceId: string | null = null;

    const cleanText =
      extracted?.cleanText && String(extracted.cleanText).trim().length > 0 ? String(extracted.cleanText).trim() : '';

    const userTextClean = (cleanText.length ? cleanText : rawText).trim();

// -------------------------------------------------------
// 11) extra sanitize（route.tsでIT強制は扱わない）
// -------------------------------------------------------
const rawExtra: Record<string, any> =
  extraReq && typeof extraReq === 'object' ? (extraReq as Record<string, any>) : {};

const sanitizedExtra: Record<string, any> = { ...rawExtra };

delete (sanitizedExtra as any).forceIT;
delete (sanitizedExtra as any).renderMode;
delete (sanitizedExtra as any).spinLoop;
delete (sanitizedExtra as any).descentGate;
delete (sanitizedExtra as any).tLayerModeActive;
delete (sanitizedExtra as any).tLayerHint;

// ✅ req.meta 由来の speechAct は、上で作った reqSpeechActRaw を正本として使う
// （ここで再宣言しない）
const reqMeta: any = (body as any)?.meta ?? null;
const reqExtraFromMeta: any = reqMeta?.extra ?? null;

// ※ reqSpeechActRaw は上の「Request meta passthrough」ブロックで確定済み

// ✅ route.ts SoT extra
let extraSoT: Record<string, any> = {
  ...sanitizedExtra,

  // ✅ Mu人格設定（/iros-ai/settings → irosTransport → /reply）

  // ✅ speechAct は req.meta 由来でも必ず SoT に刻む（下流は extra が正本）
  speechAct:
    reqSpeechActRaw != null && String(reqSpeechActRaw).trim() !== ''
      ? String(reqSpeechActRaw).trim()
      : (sanitizedExtra as any)?.speechAct ?? null,
  speechActReason:
    (sanitizedExtra as any)?.speechActReason ??
    (reqSpeechActRaw != null && String(reqSpeechActRaw).trim() !== '' ? 'from_request' : null),
  speechActConfidence:
    (sanitizedExtra as any)?.speechActConfidence ??
    (reqSpeechActRaw != null && String(reqSpeechActRaw).trim() !== '' ? 1 : null),

  // NextStep系は SoT へも載せない（常に null）
  choiceId: null,
  extractedChoiceId: null,

  traceId,
};
    const reqOrigin = req.headers.get('origin') ?? req.headers.get('x-forwarded-origin') ?? req.nextUrl?.origin ?? '';

    // ✅ RenderEngine gate（PREで1回だけ確定し、以降はSoTに同期）
    {
      const envAllows = process.env.IROS_ENABLE_RENDER_ENGINE === '1';
      const enableRenderEngine = envAllows && extraSoT.renderEngine !== false && extraSoT.renderEngineGate !== false;

      extraSoT = {
        ...extraSoT,
        renderEngineGate: enableRenderEngine,
        renderEngine: enableRenderEngine,
      };
    }

    // ✅ persist gate（single-writer）
    extraSoT = {
      ...extraSoT,
      persistedByRoute: true,
      persistPolicy: PERSIST_POLICY,
      persistAssistantMessage: false,
    };

    // ✅ IMPORTANT:
    // - user message の永続化は /api/agent/iros/messages が single-writer
    // - この /reply は user message を保存しない（重複防止）
    // - assistant message はこのrouteが single-writer（1回だけ）

    // -------------------------------------------------------
    // 11.8) feedback summary（best-effort）
    // -------------------------------------------------------

    try {
      const feedbackSummary = await loadFeedbackSummary(supabase as any, userCode);


      if (feedbackSummary) {
        extraSoT = {
          ...(extraSoT ?? {}),
          feedbackSummary,
        };

        console.info('[IROS/feedbackSummary][inject]', {
          traceId,
          conversationId,
          userCode,
          total: feedbackSummary.total,
          deepHitCount: feedbackSummary.deepHitCount,
          goodCount: feedbackSummary.goodCount,
          mismatchCount: feedbackSummary.mismatchCount,
          lastLabels: feedbackSummary.lastLabels,
        });
      }
    } catch (e: any) {
      console.warn('[IROS/feedbackSummary][inject_failed]', {
        traceId,
        conversationId,
        userCode,
        error: String(e?.message ?? e),
      });
    }



    // -------------------------------------------------------
    // 11.95) Screenshot diagnosis context -> diagnosis followup ctx
    // -------------------------------------------------------
    {
      const screenshotDiagnosisHintText =
        typeof (extraSoT as any)?.screenshotDiagnosisHintText === 'string' &&
        String((extraSoT as any).screenshotDiagnosisHintText).trim().length > 0
          ? String((extraSoT as any).screenshotDiagnosisHintText).trim()
          : typeof (reqMetaRaw as any)?.extra?.screenshotDiagnosisHintText === 'string' &&
              String((reqMetaRaw as any).extra.screenshotDiagnosisHintText).trim().length > 0
            ? String((reqMetaRaw as any).extra.screenshotDiagnosisHintText).trim()
            : null;

      const currentUserTextForScreenshotContextGate = String(
        (body as any)?.text ??
          (body as any)?.content ??
          (body as any)?.message ??
          (reqMetaRaw as any)?.userText ??
          (reqMetaRaw as any)?.text ??
          (reqMetaRaw as any)?.currentUserText ??
          (reqMetaRaw as any)?.extra?.userText ??
          (reqMetaRaw as any)?.extra?.text ??
          ''
      ).trim();

      const hasExplicitScreenshotDiagnosisIdForContextGate =
        /スクショ診断\s*(?:ID|id)?[:：]?\s*\d+/u.test(currentUserTextForScreenshotContextGate) ||
        /スクリーンショット診断\s*(?:ID|id)?[:：]?\s*\d+/u.test(currentUserTextForScreenshotContextGate);

      const hasNearbyScreenshotDiagnosisReferenceForContextGate =
        /(?:この|今の|上の|さっきの|直前の|前の)\s*(?:スクショ診断|スクリーンショット診断|画像診断|診断結果|診断|結果)/u.test(
          currentUserTextForScreenshotContextGate
        ) ||
        /(?:スクショ|スクリーンショット|画像).*(?:診断|結果|続き|深め|詳しく|相手|気持ち)/u.test(
          currentUserTextForScreenshotContextGate
        ) ||
        /(?:診断結果|診断|結果).*(?:続き|深め|詳しく|相手|気持ち|読み解|見て|教えて)/u.test(
          currentUserTextForScreenshotContextGate
        );

      const hasTopicSwitchForScreenshotContextGate =
        /(?:ところで|話(?:を)?変える|話変わる|別件|それとは別|関係ない|実装|コード|GitHub|github|プッシュ|コミット|ブランチ|typecheck|npm|PC|パソコン|課金|料金|Muverse)/u.test(
          currentUserTextForScreenshotContextGate
        );

      const isExplicitScreenshotDiagnosisTurnForContextGate =
        hasExplicitScreenshotDiagnosisIdForContextGate ||
        (Boolean(screenshotDiagnosisHintText) &&
          hasNearbyScreenshotDiagnosisReferenceForContextGate &&
          !hasTopicSwitchForScreenshotContextGate);

      if (!isExplicitScreenshotDiagnosisTurnForContextGate && screenshotDiagnosisHintText) {
        console.log('[IROS/SCREENSHOT_DIAG_CTX_SKIPPED_NON_EXPLICIT]', {
          traceId,
          conversationId,
          userCode,
          userTextHead: currentUserTextForScreenshotContextGate.slice(0, 120),
          hintLen: screenshotDiagnosisHintText.length,
          hasExplicitScreenshotDiagnosisId: hasExplicitScreenshotDiagnosisIdForContextGate,
          hasNearbyReference: hasNearbyScreenshotDiagnosisReferenceForContextGate,
          hasTopicSwitch: hasTopicSwitchForScreenshotContextGate,
        });
      }

      if (screenshotDiagnosisHintText && isExplicitScreenshotDiagnosisTurnForContextGate) {
        const previousCtxPack =
          extraSoT.ctxPack && typeof extraSoT.ctxPack === 'object'
            ? extraSoT.ctxPack
            : {};

        const screenshotLastIrDiagnosis = {
          source: 'mu_first_screenshot',
          kind: 'screenshot_diagnosis',
          targetLabel: 'スクショ診断',
          diagnosisFollowupTargetLabel: 'スクショ診断',
          diagnosisText: screenshotDiagnosisHintText,
          text: screenshotDiagnosisHintText,
          at: new Date().toISOString(),
        };

        extraSoT = {
          ...extraSoT,
          screenshotDiagnosisContext: true,
          screenshotDiagnosisHintText,
          diagnosisFollowup: true,
          diagnosisFollowupTargetLabel: 'スクショ診断',
          lastIrDiagnosis: screenshotLastIrDiagnosis,
          ctxPack: {
            ...previousCtxPack,
            screenshotDiagnosisContext: true,
            screenshotDiagnosisHintText,
            diagnosisFollowup: true,
            diagnosisFollowupTargetLabel: 'スクショ診断',
            lastIrDiagnosis: screenshotLastIrDiagnosis,
          },
        };

        console.log('[IROS/SCREENSHOT_DIAG_CTX_INJECTED]', {
          traceId,
          conversationId,
          userCode,
          hintLen: screenshotDiagnosisHintText.length,
          hintHead: screenshotDiagnosisHintText.slice(0, 180),
          hasLastIrDiagnosis: Boolean((extraSoT as any)?.lastIrDiagnosis),
          hasCtxPackLastIrDiagnosis: Boolean((extraSoT as any)?.ctxPack?.lastIrDiagnosis),
          resolvedBy: hasExplicitScreenshotDiagnosisIdForContextGate ? 'explicit_id' : 'nearby_reference',
        });
      }
    }
        // -------------------------------------------------------
    // 11.96) Screenshot diagnosis should not use similar-flow memory
    // -------------------------------------------------------
    // スクショ診断の続きでは、今回のスクショ診断本文を正本にする。
    // 過去の似た会話 seed が混ざると、別名・過去文体・古い診断が混入するため止める。
    if (Boolean((extraSoT as any)?.screenshotDiagnosisContext) ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        )) {
      try {
        delete (extraSoT as any).similarFlowSeed;
        delete (extraSoT as any).similarFlowDebug;

        if ((extraSoT as any).ctxPack && typeof (extraSoT as any).ctxPack === 'object') {
          delete (extraSoT as any).ctxPack.similarFlowSeed;
          delete (extraSoT as any).ctxPack.similarFlowDebug;
        }

        console.log('[IROS/SCREENSHOT_DIAG_SIMILAR_FLOW_DISABLED]', {
          traceId,
          conversationId,
          userCode,
        });
      } catch {}
    }
    // -------------------------------------------------------
    // 11.97) Pre-SEED Engine
    // - 保存済み診断IDなど、通常チャットに入れる前に正本・ルートを確定する
    // - v1: スクショ診断ID:n の続き相談は direct_reply で Writer/Rephrase を bypass
    // -------------------------------------------------------
    // 11.974) Relationship Context Capture Layer
    // - ユーザーが明示した関係性だけ保存する
    // - 質問・相談文は保存しない
    // - private relationship は通常の人物情報としては出さない
    // -------------------------------------------------------
    try {
      const relationshipContextCapture = await captureRelationshipContextFromConversation({
          supabase: supabase as any,
          userCode,
          conversationId,
          userText: userTextClean,
          traceId,
        });

        if (
          (relationshipContextCapture?.captured || relationshipContextCapture?.shouldAskConfirmation) &&
          relationshipContextCapture.directReply
        ) {
          const fallbackDirectText = String(relationshipContextCapture.directReply ?? '').trim();
          let directText = fallbackDirectText;

          try {
            const llmText = await chatComplete({
              purpose: 'reply',
              traceId,
              conversationId,
              userCode,
              max_tokens: 180,
              audit: {
                slotPlanPolicy: 'FINAL',
                mode,
                qCode: 'Q3',
                depthStage: 'S1',
              },
              messages: [
                {
                  role: 'system',
                  content: [
                    'あなたは Mu の保存確認文を自然に整える担当です。',
                    '',
                    '目的は、関係性を保存したことを、断定しすぎず短く自然に伝えることです。',
                    '',
                    '禁止:',
                    '- 新しい診断を始めない',
                    '- 相手の気持ちを推測しない',
                    '- 関係の結論を出さない',
                    '- 助言を増やさない',
                    '- 箇条書きにしない',
                    '- 「保存しました」「DB」「記録」などの機械語を出さない',
                    '',
                    '必須:',
                    '- 1〜2文で返す',
                    '- 保存された関係性だけを自然に言い換える',
                    '- 普通の人物情報としては出さず、関係相談の時だけ使う前提を必要ならやわらかく添える',
                    '- 呼び名は targetLabel を尊重する',
                    '- 文体は、やさしく自然な Mu の本文にする',
                  ].join('\\n'),
                },
                {
                  role: 'user',
                  content: [
                    `元のユーザー入力: ${userTextClean}`,
                    `対象人物: ${relationshipContextCapture.targetLabel ?? ''}`,
                    `関係性: ${relationshipContextCapture.valueText ?? ''}`,
                    `内部kind: ${relationshipContextCapture.kind ?? ''}`,
                    `sensitivity: ${relationshipContextCapture.sensitivity ?? ''}`,
                    '',
                    'この保存確認文を、Muの自然な本文にしてください。',
                    '禁止：片思いと断定する、相手との関係を決めつける、「前提にする」「見ておく」を強く言いすぎる。',
                    '推奨：「気になっている相手との関係として、いったん受け取ります」「決めつけずに見ていきます」のように柔らかく言う。',
                    `テンプレ原文: ${fallbackDirectText}`,
                  ].join('\\n'),
                },
              ],
            });

            const normalizedLlmText = String(llmText ?? '').trim();
            if (normalizedLlmText) {
              directText = normalizedLlmText;
            }

            console.log('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][LLM_NATURALIZED]', {
              traceId,
              conversationId,
              userCode,
              fallbackLen: fallbackDirectText.length,
              llmLen: normalizedLlmText.length,
              textHead: directText.slice(0, 160),
            });
          } catch (e: any) {
            console.warn('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][LLM_NATURALIZE_FAILED]', {
              traceId,
              conversationId,
              userCode,
              error: e?.message ?? e,
            });
          }

          
const enrichedRelationshipContextCapture = enrichRelationshipIdentity(
  {
    targetLabel: relationshipContextCapture.targetLabel ?? null,
    kind: relationshipContextCapture.kind ?? null,
    status: relationshipContextCapture.status ?? 'confirmed_by_user',
    confidence: relationshipContextCapture.confidence ?? 'high',
    relationshipContext: {
      targetLabel: relationshipContextCapture.targetLabel ?? null,
      kind: relationshipContextCapture.kind ?? null,
      status: relationshipContextCapture.status ?? 'confirmed_by_user',
      confidence: relationshipContextCapture.confidence ?? 'high',
      sensitivity: relationshipContextCapture.sensitivity ?? null,
      source: 'relationship_context_capture',
    },
    relationshipCapture: {
      targetLabel: relationshipContextCapture.targetLabel ?? null,
      kind: relationshipContextCapture.kind ?? null,
      status: relationshipContextCapture.status ?? 'confirmed_by_user',
      confidence: relationshipContextCapture.confidence ?? 'high',
      sensitivity: relationshipContextCapture.sensitivity ?? null,
      source: 'relationship_context_capture',
    },
  },
  userCode,
);
const metaForRelationshipContextCapture: any = {
            ...(metaForIros ?? {}),
            mode,
            q_code: 'Q3',
            depth_stage: 'S1',
            e_turn: 'e3',
            extra: {
              ...((metaForIros as any)?.extra ?? {}),
              persistedByRoute: true,
              persistPolicy: 'REPLY_SINGLE_WRITER',
              persistAssistantMessage: false,

              relationshipContextCapture: true,
              relationshipIdentityPatchMarker: 'relationship_context_capture_identity_v1',
              displayName: enrichedRelationshipContextCapture.displayName,
              personId: enrichedRelationshipContextCapture.personId,
              relationId: enrichedRelationshipContextCapture.relationId,
              referenceTarget: enrichedRelationshipContextCapture.referenceTarget,
              relationshipContextCaptureTargetLabel: relationshipContextCapture.targetLabel ?? null,
              relationshipContextCaptureKind: relationshipContextCapture.kind ?? null,
              relationshipContextCaptureValueText: relationshipContextCapture.valueText ?? null,
              relationshipContextCaptureValueNormalized: relationshipContextCapture.valueNormalized ?? null,
              relationshipContextCaptureStatus: relationshipContextCapture.status ?? null,
              relationshipContextCaptureConfidence: relationshipContextCapture.confidence ?? null,
              relationshipContextCaptureSensitivity: relationshipContextCapture.sensitivity ?? null,
              relationshipContextCaptureSource: relationshipContextCapture.source ?? null,
              relationshipContextCaptureNeedsConfirmation: relationshipContextCapture.shouldAskConfirmation ?? false,
              targetLabel: relationshipContextCapture.targetLabel ?? null,
              relationshipContext: {
                ...enrichedRelationshipContextCapture.relationshipContext,
                sensitivity: relationshipContextCapture.sensitivity ?? null,
                source: 'relationship_context_capture',
              },
              relationshipCapture: {
                ...enrichedRelationshipContextCapture.relationshipCapture,
                sensitivity: relationshipContextCapture.sensitivity ?? null,
                source: 'relationship_context_capture',
              },
              ctxPack: {
                ...(((metaForIros as any)?.extra ?? {})?.ctxPack ?? {}),
                targetLabel: enrichedRelationshipContextCapture.targetLabel,
                displayName: enrichedRelationshipContextCapture.displayName,
                personId: enrichedRelationshipContextCapture.personId,
                relationId: enrichedRelationshipContextCapture.relationId,
                referenceTarget: enrichedRelationshipContextCapture.referenceTarget,
                relationshipContextCaptureTargetLabel: enrichedRelationshipContextCapture.targetLabel,
                relationshipContextCaptureKind: enrichedRelationshipContextCapture.kind,
                relationshipContext: {
                  ...enrichedRelationshipContextCapture.relationshipContext,
                  sensitivity: relationshipContextCapture.sensitivity ?? null,
                  source: 'relationship_context_capture',
                },
                relationshipCapture: {
                  ...enrichedRelationshipContextCapture.relationshipCapture,
                  sensitivity: relationshipContextCapture.sensitivity ?? null,
                  source: 'relationship_context_capture',
                },
              },

              shouldSuppressSimilarFlow: true,
              finalTextPolicy: 'FINAL_TEXT_SYNCED_RELATIONSHIP_CONTEXT_CAPTURE',
              resolvedText: directText,
              finalAssistantText: directText,
              rawTextFromModel: directText,
              extractedTextFromModel: directText,
            },
          };

          let relationshipContextSaved: any = null;

          try {
            relationshipContextSaved = await persistAssistantMessageToIrosMessages({
              supabase,
              conversationId,
              userCode,
              content: directText,
              meta: metaForRelationshipContextCapture,
            } as any);
          } catch (e: any) {
            console.warn('[IROS/ROUTE][RELATIONSHIP_CONTEXT_CAPTURE_PERSIST_FAILED]', {
              traceId,
              conversationId,
              userCode,
              error: e?.message ?? e,
            });
          }

          console.log('[IROS/ROUTE][RELATIONSHIP_CONTEXT_CAPTURE_RETURN]', {
            traceId,
            conversationId,
            userCode,
            targetLabel: relationshipContextCapture.targetLabel ?? null,
            kind: relationshipContextCapture.kind ?? null,
            savedOk: relationshipContextSaved?.ok ?? null,
            savedInserted: relationshipContextSaved?.inserted ?? null,
            messageId: relationshipContextSaved?.messageId ?? null,
            textLen: directText.length,
            textHead: directText.slice(0, 160),
          });

          return NextResponse.json(
            {
              ok: true,
              result: {
                text: directText,
                content: directText,
                assistantText: directText,
                mode,
                meta: metaForRelationshipContextCapture,
              },
              text: directText,
              content: directText,
              assistantText: directText,
              assistantMessageId: relationshipContextSaved?.messageId ?? null,
              mode,
              finalMode: mode,
              meta: metaForRelationshipContextCapture,
              metaForSave: metaForRelationshipContextCapture,
              credit: {
                ref: creditRef,
                amount: CREDIT_AMOUNT,
                authorize: authRes,
                lowWarn,
              },
            },
            { status: 200, headers: withTrace(CORS_HEADERS, traceId) },
          );
        }

        console.info('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][SKIP]', {
          traceId,
          conversationId,
          userCode,
          reason: relationshipContextCapture?.reason ?? null,
        });
    } catch (e: any) {
      console.warn('[IROS/RELATIONSHIP_CONTEXT_CAPTURE][FAILED]', {
        traceId,
        conversationId,
        userCode,
        error: e?.message ?? e,
      });
    }

    // -------------------------------------------------------
    console.log('[IROS/ROUTE][PRE_SEED_ENTER]', {
      traceId,
      conversationId,
      userCode,
      userTextClean,
      userTextCleanHead: String(userTextClean ?? '').slice(0, 120),
      hasSupabase: Boolean((supabase as any)?.from),
    });

    const preSeedMeta: any = {
      ...(metaForIros ?? {}),
      ...(extraSoT ?? {}),
      extra: {
        ...((metaForIros as any)?.extra ?? {}),
        ...(extraSoT ?? {}),
        ctxPack: {
          ...(((metaForIros as any)?.extra ?? {})?.ctxPack ?? {}),
          ...(((extraSoT as any)?.ctxPack ?? {})),
        },
      },
      ctxPack: {
        ...((metaForIros as any)?.ctxPack ?? {}),
        ...(((extraSoT as any)?.ctxPack ?? {})),
      },
    };

    const preSeedDecision = await resolvePreSeedDecision({
      userText: userTextClean,
      userCode,
      conversationId,
      supabase: supabase as any,
      meta: preSeedMeta,
      historyForTurn: Array.isArray(chatHistory) ? chatHistory : [],
      traceId,
    });

    const preSeedFlowDirective = buildPreSeedFlowDirective({
      userText: userTextClean,
      decision: preSeedDecision,
      meta: preSeedMeta,
      historyForTurn: Array.isArray(chatHistory) ? chatHistory : [],
    });

    {
      const previousCtxPack =
        extraSoT.ctxPack && typeof extraSoT.ctxPack === 'object'
          ? extraSoT.ctxPack
          : {};

      const preSeedConvergesToIntention =
        preSeedFlowDirective.flowDirection === 'converge_to_intention' ||
        preSeedFlowDirective.convergenceMode === 'toward_intention' ||
        preSeedFlowDirective.intentionConvergence?.intentionReached === true;

      const preSeedConvergesToCreate =
        preSeedFlowDirective.convergenceMode === 'toward_create' ||
        preSeedFlowDirective.convergenceMode === 'toward_small_action' ||
        preSeedFlowDirective.shouldUseCreate === true ||
        preSeedFlowDirective.shouldUseSmallAction === true;

      
      const preSeedCreateModeForBridge = String(
        preSeedFlowDirective.createDirective?.mode ?? ''
      ).trim();

      const preSeedCreateBridgeMode =
        preSeedCreateModeForBridge === 'image_first_create'
          ? 'image_first_create'
          : preSeedCreateModeForBridge === 'flow_acceptance'
            ? 'future_create'
            : preSeedConvergesToCreate
              ? 'future_create'
              : null;

      const preSeedCreateBridgeFocusLabel =
        preSeedCreateBridgeMode === 'image_first_create'
          ? '相手の反応待ちから、自分の時間を先に戻す形'
          : preSeedCreateBridgeMode === 'future_create'
            ? 'いまの理解を、次の未来の形へ置く'
            : null;

      const createProgressBridge = preSeedCreateBridgeMode
        ? {
            kind: 'create_progress_bridge',
            mode: preSeedCreateBridgeMode,
            laneKey: 'T_CONCRETIZE',
            focusLabel: preSeedCreateBridgeFocusLabel,
            reason:
              'preseed_create_ready: do not force action; move by imaginal/future create after convergence',
          }
        : null;
      const preSeedCtxPatch = preSeedConvergesToIntention
        ? {
            goalKind: 'resonate',
            targetKind: 'intention_convergence',
            shiftKind: 'narrow_shift',
            shiftHint: 'preseed_intention_convergence',
            shiftIntent: 'name_core_without_overdeepening',
            replyGoal: { kind: 'resonate' },
            preSeedWriterGuidance: preSeedFlowDirective.writerGuidance,
            preSeedWriterSeed: preSeedFlowDirective.seedDirection?.writerSeed ?? null,
            preSeedCreateDirective: preSeedFlowDirective.createDirective ?? null,
            createProgressBridge,
            laneKey: createProgressBridge?.laneKey ?? null,
            focusLabel: createProgressBridge?.focusLabel ?? null,
          }
        : preSeedConvergesToCreate
          ? {
              goalKind: 'enableAction',
              targetKind: 'imaginal_form_create',
              shiftKind: 'imaginal_form_shift',
              shiftHint: 'preseed_image_first_create',
              shiftIntent: 'place_imaginal_form',
              replyGoal: { kind: 'enableAction', mode: 'image_first_create', targetKind: 'imaginal_form_create' },
              preSeedWriterGuidance: preSeedFlowDirective.writerGuidance,
              preSeedWriterSeed: preSeedFlowDirective.seedDirection?.writerSeed ?? null,
            preSeedCreateDirective: preSeedFlowDirective.createDirective ?? null,
            createProgressBridge,
            laneKey: createProgressBridge?.laneKey ?? null,
            focusLabel: createProgressBridge?.focusLabel ?? null,
          }
          : {
              preSeedWriterGuidance: preSeedFlowDirective.writerGuidance,
              preSeedWriterSeed: preSeedFlowDirective.seedDirection?.writerSeed ?? null,
            preSeedCreateDirective: preSeedFlowDirective.createDirective ?? null,
            createProgressBridge,
            laneKey: createProgressBridge?.laneKey ?? null,
            focusLabel: createProgressBridge?.focusLabel ?? null,
          };

      const imageFirstCreateSemanticOverride = preSeedConvergesToCreate
        ? [
            'IMAGE_FIRST_CREATE_SEMANTIC_OVERRIDE:',
            'このターンの small_create / targetKind は、小さな行動ではなく「小さな形象」を意味する。',
            'enableAction は、ユーザーへ行動指示する意味ではなく「内側に形を置いて、動ける状態へ戻す」意味で読む。',
            'future_design / 次の一歩 / 具体へ落とす は、送信・連絡・文面・タスクではなく、見える形・場面・姿として具体化すること。',
            'Writerは、冒頭で送信文・行動案・選択肢を出さず、まず内側に立つ形を一つ描写する。',
            '禁止：送る／送って／一通／1通／一文／文面／ひとこと／一言／連絡／今すぐ／手を動かす／紙に書く／メモに書く／片づける。',
            '最後は行動命令ではなく、その形を崩さない保持で閉じる。',
            '固定テンプレにはしない。このターンの focusLabel / flowSeed / userText から自然な文で書く。'
          ].join('\n')
        : '';

      if (imageFirstCreateSemanticOverride) {
        const prevPreSeedWriterSeed = String((preSeedCtxPatch as any).preSeedWriterSeed ?? '').trim();
        const prevPreSeedWriterGuidance = String((preSeedCtxPatch as any).preSeedWriterGuidance ?? '').trim();

        (preSeedCtxPatch as any).preSeedWriterSeed = [
          prevPreSeedWriterSeed,
          imageFirstCreateSemanticOverride,
        ].filter(Boolean).join('\n\n');

        (preSeedCtxPatch as any).preSeedWriterGuidance = [
          prevPreSeedWriterGuidance,
          imageFirstCreateSemanticOverride,
        ].filter(Boolean).join('\n\n');
      }
      extraSoT = {
        ...extraSoT,
        ...preSeedCtxPatch,
        preSeedFlowDirective,
        preSeedFlowDirectiveAppliedToGoal: preSeedConvergesToIntention || preSeedConvergesToCreate,
        ctxPack: {
          ...previousCtxPack,
          ...preSeedCtxPatch,
          preSeedFlowDirective,
        },
      };
    }

    console.log('[IROS/ROUTE][PRE_SEED_FLOW_DIRECTIVE]', {
      traceId,
      conversationId,
      userCode,
      inputIntent: preSeedFlowDirective.inputIntent,
      currentAxis: preSeedFlowDirective.currentAxis,
      currentBand: preSeedFlowDirective.currentBand,
      flowDirection: preSeedFlowDirective.flowDirection,
      shouldDeepen: preSeedFlowDirective.shouldDeepen,
      shouldLimitDeepening: preSeedFlowDirective.shouldLimitDeepening,
      createReady: preSeedFlowDirective.createReady,
      createSource: preSeedFlowDirective.createSource,
      createIntegrity: preSeedFlowDirective.createIntegrity,
      createDistortionRisk: preSeedFlowDirective.createDistortionRisk,
      evidence: preSeedFlowDirective.evidence,
    });

    console.log('[IROS/ROUTE][PRE_SEED_AFTER_RESOLVE]', {
      traceId,
      conversationId,
      userCode,
      hasDecision: Boolean(preSeedDecision),
      kind: preSeedDecision?.kind ?? null,
      route: preSeedDecision?.route ?? null,
      shouldBypassWriter: preSeedDecision?.shouldBypassWriter ?? null,
      directReplyLen: String(preSeedDecision?.directReply ?? '').length,
      seedLen: String(preSeedDecision?.seedText ?? '').length,
    });



    // -------------------------------------------------------
    // 11.975) Person Fact Capture Layer
    // - 例:
    //   user: 対象人物Aは、何歳だったっけ？
    //   Mu  : ここでは確認できません。
    //   user: この前の誕生日で、45歳っていってたよ
    // - Pre-SEED が拾えない「人物名なし補足」を、直前文脈から人物事実として保存する
    // -------------------------------------------------------
    if (!preSeedDecision) {
      try {
        const personFactCapture = await capturePersonFactFromConversation({
          supabase: supabase as any,
          userCode,
          conversationId,
          userText: userTextClean,
          traceId,
        });

        if ((personFactCapture?.captured || personFactCapture?.shouldAskConfirmation) && personFactCapture.directReply) {
          const directText = String(personFactCapture.directReply ?? '').trim();

          const metaForPersonFactCapture: any = {
            ...(metaForIros ?? {}),
            mode,
            q_code: 'Q3',
            depth_stage: 'S1',
            e_turn: 'e3',
            extra: {
              ...((metaForIros as any)?.extra ?? {}),
              persistedByRoute: true,
              persistPolicy: 'REPLY_SINGLE_WRITER',
              persistAssistantMessage: false,

              personFactCapture: true,
              personFactCaptureTargetLabel: personFactCapture.targetLabel ?? null,
              personFactCaptureField: personFactCapture.field ?? null,
              personFactCaptureValueText: personFactCapture.valueText ?? null,
              personFactCaptureValueNumber: personFactCapture.valueNumber ?? null,
              personFactCaptureValueNormalized: personFactCapture.valueNormalized ?? null,
              personFactCaptureStatus: personFactCapture.status ?? null,
              personFactCaptureConfidence: personFactCapture.confidence ?? null,
              personFactCaptureSensitivity: personFactCapture.sensitivity ?? null,
              personFactCaptureSource: personFactCapture.source ?? null,
              personFactCaptureNeedsConfirmation: personFactCapture.shouldAskConfirmation ?? false,

              finalTextPolicy: 'FINAL_TEXT_SYNCED_PERSON_FACT_CAPTURE',
              resolvedText: directText,
              finalAssistantText: directText,
              rawTextFromModel: directText,
              extractedTextFromModel: directText,
            },
          };

          let personFactSaved: any = null;

          try {
            personFactSaved = await persistAssistantMessageToIrosMessages({
              supabase,
              conversationId,
              userCode,
              content: directText,
              meta: metaForPersonFactCapture,
            } as any);
          } catch (e: any) {
            console.warn('[IROS/ROUTE][PERSON_FACT_CAPTURE_PERSIST_FAILED]', {
              traceId,
              conversationId,
              userCode,
              error: e?.message ?? e,
            });
          }

          console.log('[IROS/ROUTE][PERSON_FACT_CAPTURE_RETURN]', {
            traceId,
            conversationId,
            userCode,
            targetLabel: personFactCapture.targetLabel ?? null,
            field: personFactCapture.field ?? null,
            savedOk: personFactSaved?.ok ?? null,
            savedInserted: personFactSaved?.inserted ?? null,
            messageId: personFactSaved?.messageId ?? null,
            textLen: directText.length,
            textHead: directText.slice(0, 160),
          });

          return NextResponse.json(
            {
              ok: true,
              result: {
                text: directText,
                content: directText,
                assistantText: directText,
                mode,
                meta: metaForPersonFactCapture,
              },
              text: directText,
              content: directText,
              assistantText: directText,
              assistantMessageId: personFactSaved?.messageId ?? null,
              mode,
              finalMode: mode,
              meta: metaForPersonFactCapture,
              metaForSave: metaForPersonFactCapture,
              credit: {
                ref: creditRef,
                amount: CREDIT_AMOUNT,
                authorize: authRes,
                lowWarn,
              },
            },
            { status: 200, headers: withTrace(CORS_HEADERS, traceId) },
          );
        }

        console.info('[IROS/PERSON_FACT_CAPTURE][SKIP]', {
          traceId,
          conversationId,
          userCode,
          reason: personFactCapture?.reason ?? null,
        });
      } catch (e: any) {
        console.warn('[IROS/PERSON_FACT_CAPTURE][FAILED]', {
          traceId,
          conversationId,
          userCode,
          error: e?.message ?? e,
        });
      }
    }

    if (preSeedDecision) {
      const previousCtxPack =
        extraSoT.ctxPack && typeof extraSoT.ctxPack === 'object'
          ? extraSoT.ctxPack
          : {};

      extraSoT = {
        ...extraSoT,
        ...(preSeedDecision.metaPatch ?? {}),
        preSeedDecision,
        preSeedDecisionKind: preSeedDecision.kind,
        preSeedDecisionRoute: preSeedDecision.route,
        preSeedBypassWriter: preSeedDecision.shouldBypassWriter,
        preSeedBypassRephrase: preSeedDecision.shouldBypassRephrase,
        ctxPack: {
          ...previousCtxPack,
          ...(preSeedDecision.ctxPackPatch ?? {}),
          preSeedDecision,
        },
      };

      if (preSeedDecision.shouldSuppressHistoryForWriter) {
        (extraSoT as any).historyForWriter = [];
        if ((extraSoT as any).ctxPack && typeof (extraSoT as any).ctxPack === 'object') {
          (extraSoT as any).ctxPack.historyForWriter = [];
        }
      }

      if (preSeedDecision.shouldSuppressSimilarFlow) {
        delete (extraSoT as any).similarFlowSeed;
        delete (extraSoT as any).similarFlowDebug;
        if ((extraSoT as any).ctxPack && typeof (extraSoT as any).ctxPack === 'object') {
          delete (extraSoT as any).ctxPack.similarFlowSeed;
          delete (extraSoT as any).ctxPack.similarFlowDebug;
        }
      }

      console.log('[IROS/ROUTE][PRE_SEED_DECISION_APPLIED]', {
        traceId,
        conversationId,
        userCode,
        kind: preSeedDecision.kind,
        route: preSeedDecision.route,
        shouldBypassWriter: preSeedDecision.shouldBypassWriter,
        shouldBypassRephrase: preSeedDecision.shouldBypassRephrase,
        directReplyLen: String(preSeedDecision.directReply ?? '').length,
        seedLen: String(preSeedDecision.seedText ?? '').length,
        sourceTextLen: String(preSeedDecision.sourceText ?? '').length,
      });
    }

    if (
      preSeedDecision?.route === 'diagnosis_writer' &&
      (preSeedDecision as any).shouldUsePreSeedWriter &&
      (preSeedDecision as any).writerInput
    ) {
      const writerInput = {
        ...((preSeedDecision as any).writerInput ?? {}),
        traceId,
        conversationId,
        userCode,
      };

      const writerText = await callPreSeedDiagnosisWriter(writerInput as any);
      const fallbackText = String(preSeedDecision.directReply ?? '').trim();
      const directText = String(writerText || fallbackText || '').trim();

      if (directText) {
        const metaForPreSeedWriter: any = {
          ...(metaForIros ?? {}),
          extra: {
            ...((metaForIros as any)?.extra ?? {}),
            ...((preSeedDecision as any)?.metaPatch ?? {}),
            preSeedDecision,
            preSeedBypassWriter: true,
            preSeedBypassRephrase: preSeedDecision.shouldBypassRephrase,
            preSeedWriter: true,
            preSeedWriterKind: 'diagnosis_writer',
            ctxPack: {
              ...(((metaForIros as any)?.extra ?? {})?.ctxPack ?? {}),
              ...((preSeedDecision as any)?.ctxPackPatch ?? {}),
              preSeedDecision,
              preSeedWriter: true,
              preSeedWriterKind: 'diagnosis_writer',
            },
          },
        };

        let preSeedSaved: any = null;

        try {
          const metaForPreSeedPersist: any = {
            ...metaForPreSeedWriter,
            extra: {
              ...((metaForPreSeedWriter as any)?.extra ?? {}),
              persistedByRoute: true,
              persistPolicy: 'REPLY_SINGLE_WRITER',
              persistAssistantMessage: false,
              preSeedWriter: true,
              preSeedWriterKind: 'diagnosis_writer',
              preSeedDiagnosisWriterPersist: true,
              finalTextPolicy: 'FINAL_TEXT_SYNCED_PRE_SEED',
              resolvedText: directText,
              finalAssistantText: directText,
              rawTextFromModel: directText,
              extractedTextFromModel: directText,
            },
          };

          preSeedSaved = await persistAssistantMessageToIrosMessages({
            supabase,
            conversationId,
            userCode,
            content: directText,
            meta: metaForPreSeedPersist,
          } as any);

          console.log('[IROS/ROUTE][PRE_SEED_DIAGNOSIS_WRITER_PERSIST]', {
            traceId,
            conversationId,
            userCode,
            ok: preSeedSaved?.ok ?? null,
            inserted: preSeedSaved?.inserted ?? null,
            messageId: preSeedSaved?.messageId ?? null,
            error: preSeedSaved?.error ?? null,
          });
        } catch (e: any) {
          console.warn('[IROS/ROUTE][PRE_SEED_DIAGNOSIS_WRITER_PERSIST_FAILED]', {
            traceId,
            conversationId,
            userCode,
            error: e?.message ?? e,
          });
        }

        const preSeedTcfStarterForDiagnosisWriter =
          (preSeedDecision as any)?.tcfStarter ??
          (preSeedDecision as any)?.ctxPackPatch?.tcfStarter ??
          (preSeedDecision as any)?.metaPatch?.tcfStarter ??
          (preSeedDecision as any)?.writerInput?.tcfStarter ??
          null;

        console.log('[IROS/TCF_ROTATION_SEED][PRE_SEED_BRIDGE]', {
          traceId,
          conversationId,
          userCode,
          source: 'preseed_tcf_starter',
          route: preSeedDecision.route,
          kind: preSeedDecision.kind,
          sourceId: preSeedDecision.sourceId ?? null,
          applied: Boolean(preSeedTcfStarterForDiagnosisWriter),
          cDirection: preSeedTcfStarterForDiagnosisWriter?.cDirection ?? null,
          userReaction: preSeedTcfStarterForDiagnosisWriter?.userReaction ?? null,
          convergence: preSeedTcfStarterForDiagnosisWriter?.convergence ?? null,
          currentFocus: preSeedTcfStarterForDiagnosisWriter?.currentFocus ?? null,
          nextFocus: preSeedTcfStarterForDiagnosisWriter?.nextFocus ?? null,
          cognitionMapRelationCode:
            (preSeedDecision as any)?.cognitionMap?.relationCode ??
            (preSeedDecision as any)?.ctxPackPatch?.cognitionMap?.relationCode ??
            (preSeedDecision as any)?.metaPatch?.cognitionMap?.relationCode ??
            null,
          cognitionMapProgress:
            (preSeedDecision as any)?.cognitionMap?.progress ??
            (preSeedDecision as any)?.ctxPackPatch?.cognitionMap?.progress ??
            (preSeedDecision as any)?.metaPatch?.cognitionMap?.progress ??
            null,
        });
        console.log('[IROS/ROUTE][PRE_SEED_DIAGNOSIS_WRITER_RETURN]', {
          traceId,
          conversationId,
          userCode,
          kind: preSeedDecision.kind,
          route: preSeedDecision.route,
          sourceId: preSeedDecision.sourceId ?? null,
          usedFallback: !writerText,
          savedOk: preSeedSaved?.ok ?? null,
          savedInserted: preSeedSaved?.inserted ?? null,
          textLen: directText.length,
          textHead: directText.slice(0, 160),
        });

        return NextResponse.json(
          {
            ok: true,
            result: {
              text: directText,
              content: directText,
              assistantText: directText,
              mode,
              meta: metaForPreSeedWriter,
            },
            text: directText,
            content: directText,
            assistantText: directText,
            mode,
            finalMode: mode,
            meta: metaForPreSeedWriter,
            metaForSave: metaForPreSeedWriter,
            credit: {
              ref: creditRef,
              amount: CREDIT_AMOUNT,
              authorize: authRes,
              lowWarn,
            },
          },
          { status: 200, headers: withTrace(CORS_HEADERS, traceId) },
        );
      }

      console.warn('[IROS/ROUTE][PRE_SEED_DIAGNOSIS_WRITER_EMPTY]', {
        traceId,
        conversationId,
        userCode,
        kind: preSeedDecision.kind,
        route: preSeedDecision.route,
        sourceId: preSeedDecision.sourceId ?? null,
      });
    }
    if (
      (preSeedDecision?.route === 'direct_reply' || preSeedDecision?.route === 'clarify') &&
      preSeedDecision.shouldBypassWriter &&
      preSeedDecision.directReply
    ) {
      const directText = String(preSeedDecision.directReply ?? '').trim();

      const metaForDirectReply: any = {
        ...(metaForIros ?? {}),
        extra: {
          ...((metaForIros as any)?.extra ?? {}),
          ...((preSeedDecision as any)?.metaPatch ?? {}),
          preSeedDecision,
          preSeedBypassWriter: true,
          preSeedBypassRephrase: preSeedDecision.shouldBypassRephrase,
          ctxPack: {
            ...(((metaForIros as any)?.extra ?? {})?.ctxPack ?? {}),
            ...((preSeedDecision as any)?.ctxPackPatch ?? {}),
            preSeedDecision,
          },
        },
      };

      let preSeedDirectSaved: any = null;

      try {
        const metaForPreSeedDirectPersist: any = {
          ...metaForDirectReply,
          extra: {
            ...((metaForDirectReply as any)?.extra ?? {}),
            persistedByRoute: true,
            persistPolicy: 'REPLY_SINGLE_WRITER',
            persistAssistantMessage: false,
            preSeedDirectReplyPersist: true,
            finalTextPolicy: 'FINAL_TEXT_SYNCED_PRE_SEED_DIRECT_REPLY',
            resolvedText: directText,
            finalAssistantText: directText,
            rawTextFromModel: directText,
            extractedTextFromModel: directText,
          },
        };

        preSeedDirectSaved = await persistAssistantMessageToIrosMessages({
          supabase,
          conversationId,
          userCode,
          content: directText,
          meta: metaForPreSeedDirectPersist,
        } as any);

        console.log('[IROS/ROUTE][PRE_SEED_DIRECT_REPLY_PERSIST]', {
          traceId,
          conversationId,
          userCode,
          ok: preSeedDirectSaved?.ok ?? null,
          inserted: preSeedDirectSaved?.inserted ?? null,
          messageId: preSeedDirectSaved?.messageId ?? null,
          error: preSeedDirectSaved?.error ?? null,
        });
      } catch (e: any) {
        console.warn('[IROS/ROUTE][PRE_SEED_DIRECT_REPLY_PERSIST_FAILED]', {
          traceId,
          conversationId,
          userCode,
          error: e?.message ?? e,
        });
      }

      console.log('[IROS/ROUTE][PRE_SEED_DIRECT_REPLY_RETURN]', {
        traceId,
        conversationId,
        userCode,
        kind: preSeedDecision.kind,
        sourceId: preSeedDecision.sourceId ?? null,
        directReplyLen: directText.length,
        directReplyHead: directText.slice(0, 160),
      });

      return NextResponse.json(
        {
          ok: true,
          result: {
            text: directText,
            content: directText,
            assistantText: directText,
            mode,
            meta: metaForDirectReply,
          },
          text: directText,
          content: directText,
          assistantText: directText,
          mode,
          finalMode: mode,
          meta: metaForDirectReply,
          metaForSave: metaForDirectReply,
          credit: {
            ref: creditRef,
            amount: CREDIT_AMOUNT,
            authorize: authRes,
            lowWarn,
          },
        },
        { status: 200, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }

    // -------------------------------------------------------
    // 11.9) Similar Flow pre-writer seed（best-effort）
    // -------------------------------------------------------
    try {
      const shouldSkipSimilarFlowByPreSeed =
        Boolean((preSeedDecision as any)?.shouldSuppressSimilarFlow) ||
        Boolean((preSeedDecision as any)?.shouldUsePreSeedWriter) ||
        Boolean((preSeedDecision as any)?.shouldBypassWriter) ||
        Boolean((extraSoT as any)?.preSeedBypassWriter) ||
        Boolean((extraSoT as any)?.screenshotDiagnosisContext) ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        );

      if (shouldSkipSimilarFlowByPreSeed) {
        console.log('[IROS/SIMILAR_FLOW_PRE_WRITER][SKIP_PRE_SEED]', {
          traceId,
          conversationId,
          userCode,
          preSeedKind: (preSeedDecision as any)?.kind ?? null,
          preSeedRoute: (preSeedDecision as any)?.route ?? null,
          shouldSuppressSimilarFlow: (preSeedDecision as any)?.shouldSuppressSimilarFlow ?? null,
          shouldUsePreSeedWriter: (preSeedDecision as any)?.shouldUsePreSeedWriter ?? null,
          shouldBypassWriter: (preSeedDecision as any)?.shouldBypassWriter ?? null,
          hasScreenshotDiagnosisContext: Boolean((extraSoT as any)?.screenshotDiagnosisContext) ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        ),
        });
      } else {
      const preSimilarFlowLookup = await loadSimilarFlowSnapshots({
        supabase: supabase as any,
        userCode,
        conversationId,
        sourceTypes: ['chat'],
        situationTopic: userTextClean,
        keywords: [userTextClean].filter((v): v is string => Boolean(String(v ?? '').trim())),
        recentLimit: 80,
        limit: 3,
      });

      const preSimilarFlowSeed = buildSimilarFlowSeed({
        matches: preSimilarFlowLookup.matches,
        currentState: {},
        limit: 3,
        maxChars: 1600,
      });

      const shouldDisableSimilarFlowForCreateBridge =
        String((extraSoT as any)?.preSeedCreateDirective?.mode ?? '').trim() === 'image_first_create' ||
        String((extraSoT as any)?.createProgressBridge?.mode ?? '').trim() === 'image_first_create' ||
        String((extraSoT as any)?.ctxPack?.preSeedCreateDirective?.mode ?? '').trim() === 'image_first_create' ||
        String((extraSoT as any)?.ctxPack?.createProgressBridge?.mode ?? '').trim() === 'image_first_create' ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        );

      const shouldDisableSimilarFlowForScreenshotDiagnosisPreWriter =
        /スクショ診断\s*(?:ID|id)?[:：]?\s*\d*/u.test(String((reqMeta as any)?.userText ?? (reqMeta as any)?.text ?? (reqMeta as any)?.currentUserText ?? '')) ||
        /スクリーンショット診断\s*(?:ID|id)?[:：]?\s*\d*/u.test(String((reqMeta as any)?.userText ?? (reqMeta as any)?.text ?? (reqMeta as any)?.currentUserText ?? '')) ||
        String((reqMeta as any)?.screenshotDiagnosisContext ?? '').trim().length > 0 ||
        String((reqMeta as any)?.screenshotDiagnosisHintText ?? '').trim().length > 0 ||
        String((reqMeta as any)?.ctxPack?.screenshotDiagnosisContext ?? '').trim().length > 0 ||
        String((reqMeta as any)?.ctxPack?.screenshotDiagnosisHintText ?? '').trim().length > 0 ||
        String((reqMeta as any)?.ctxPack?.presentationKind ?? '').trim() === 'screenshot_diagnosis_followup' ||
        String((reqMeta as any)?.ctxPack?.continuityKind ?? '').trim() === 'screenshot_diagnosis_followup' ||
        shouldDisableSimilarFlowForCreateBridge;

      if (shouldDisableSimilarFlowForScreenshotDiagnosisPreWriter) {
        console.log('[IROS/SIMILAR_FLOW_PRE_WRITER][SKIP_SCREENSHOT_DIAGNOSIS]', {
          conversationId,
          userCode,
          userTextHead: String((reqMeta as any)?.userText ?? (reqMeta as any)?.text ?? (reqMeta as any)?.currentUserText ?? '').slice(0, 120),
          hasScreenshotContext: String((reqMeta as any)?.screenshotDiagnosisContext ?? '').trim().length > 0,
          hasScreenshotHint: String((reqMeta as any)?.screenshotDiagnosisHintText ?? '').trim().length > 0,
        });
      }

      if (preSimilarFlowSeed && !shouldDisableSimilarFlowForScreenshotDiagnosisPreWriter) {
        const previousCtxPack =
          extraSoT.ctxPack && typeof extraSoT.ctxPack === 'object'
            ? extraSoT.ctxPack
            : {};

        const preSimilarFlowDebug = {
          source: 'pre_writer',
          lookupOk: preSimilarFlowLookup.ok,
          matchesLen: preSimilarFlowLookup.matches.length,
          hasSeed: true,
          seedLen: String(preSimilarFlowSeed).length,
          lookupError: preSimilarFlowLookup.ok ? null : String((preSimilarFlowLookup as any).error ?? ''),
        };

        extraSoT = {
          ...extraSoT,
          similarFlowSeed: preSimilarFlowSeed,
          similarFlowDebug: preSimilarFlowDebug,
          ctxPack: {
            ...previousCtxPack,
            similarFlowSeed: preSimilarFlowSeed,
            similarFlowDebug: preSimilarFlowDebug,
          },
        };
      }

      console.log('[IROS/SIMILAR_FLOW_PRE_WRITER]', {
        conversationId,
        userCode,
        lookupOk: preSimilarFlowLookup.ok,
        matchesLen: preSimilarFlowLookup.matches.length,
        hasSeed: Boolean(preSimilarFlowSeed),
        seedLen: String(preSimilarFlowSeed ?? '').length,
        similarFlowSeedHead: String(preSimilarFlowSeed ?? '').slice(0, 1200),
        similarFlowSeedHasFalseRecall: /覚えています|もちろん、覚えています|残っています|受け取っています|沖縄の風|海の色|空気|景色|温度/.test(String(preSimilarFlowSeed ?? '')),
        similarFlowSeedFalseRecallMatches: String(preSimilarFlowSeed ?? '').match(/覚えています|もちろん、覚えています|残っています|受け取っています|沖縄の風|海の色|空気|景色|温度/g) ?? [],
      });
      }
    } catch (e) {
      console.warn('[IROS/SIMILAR_FLOW_PRE_WRITER][FAILED]', {
        conversationId,
        userCode,
        error: e,
      });
    }


    // -------------------------------------------------------
    // 12) handle
    // -------------------------------------------------------

    // -------------------------------------------------------
    // 11.98) Person Context Pre-SEED writer persist
    // - direct return ではなく、assistant message として保存して返す
    // - handleIrosReply には入れない：slotPlan に負けるため
    // - ただし persistAssistantMessageToIrosMessages を通すので履歴・created_at は残る
    // -------------------------------------------------------
    if (
      preSeedDecision?.kind === 'person_reference' &&
      preSeedDecision?.shouldBypassWriter === true &&
      typeof preSeedDecision?.directReply === 'string' &&
      preSeedDecision.directReply.trim().length > 0
    ) {
      const directText = preSeedDecision.directReply.trim();

      const metaForPersonContext: any = {
        ...(metaForIros ?? {}),
        mode,
        q_code: 'Q3',
        depth_stage: 'S1',
        e_turn: 'e3',
        extra: {
          ...((metaForIros as any)?.extra ?? {}),
          ...((preSeedDecision as any)?.metaPatch ?? {}),
          persistedByRoute: true,
          persistPolicy: 'REPLY_SINGLE_WRITER',
          persistAssistantMessage: false,

          preSeedPersonContextWriter: true,
          preSeedDirectReply: true,
          preSeedKind: preSeedDecision.kind ?? null,
          preSeedRoute: preSeedDecision.route ?? null,
          sourceKind: (preSeedDecision as any).sourceKind ?? null,
          sourceId: (preSeedDecision as any).sourceId ?? null,

          finalTextPolicy: 'FINAL_TEXT_SYNCED_PERSON_CONTEXT_PRE_SEED',
          resolvedText: directText,
          finalAssistantText: directText,
          rawTextFromModel: directText,
          extractedTextFromModel: directText,

          ctxPack: {
            ...(((metaForIros as any)?.extra ?? {})?.ctxPack ?? {}),
            ...((preSeedDecision as any)?.ctxPackPatch ?? {}),
            preSeedDecision,
            preSeedPersonContextWriter: true,
            preSeedDirectReply: true,
            directReplyCandidate: directText,
            personContextSeedText: String((preSeedDecision as any).seedText ?? ''),
            personContextSourceText: String((preSeedDecision as any).sourceText ?? ''),
          },
        },
      };

      let personContextSaved: any = null;

      try {
        personContextSaved = await persistAssistantMessageToIrosMessages({
          supabase,
          conversationId,
          userCode,
          content: directText,
          meta: metaForPersonContext,
        } as any);

        console.log('[IROS/ROUTE][PRE_SEED_PERSON_CONTEXT_WRITER_PERSIST]', {
          traceId,
          conversationId,
          userCode,
          ok: personContextSaved?.ok ?? null,
          inserted: personContextSaved?.inserted ?? null,
          messageId: personContextSaved?.messageId ?? null,
          error: personContextSaved?.error ?? null,
          directReplyLen: directText.length,
        });
      } catch (e: any) {
        console.warn('[IROS/ROUTE][PRE_SEED_PERSON_CONTEXT_WRITER_PERSIST_FAILED]', {
          traceId,
          conversationId,
          userCode,
          error: e?.message ?? e,
          directReplyLen: directText.length,
        });
      }

      console.log('[IROS/ROUTE][PRE_SEED_PERSON_CONTEXT_WRITER_RETURN]', {
        traceId,
        conversationId,
        userCode,
        kind: preSeedDecision.kind,
        route: preSeedDecision.route,
        sourceId: preSeedDecision.sourceId ?? null,
        savedOk: personContextSaved?.ok ?? null,
        savedInserted: personContextSaved?.inserted ?? null,
        messageId: personContextSaved?.messageId ?? null,
        textLen: directText.length,
        textHead: directText.slice(0, 160),
      });

      return NextResponse.json(
        {
          ok: true,
          result: {
            text: directText,
            content: directText,
            assistantText: directText,
            mode,
            meta: metaForPersonContext,
          },
          text: directText,
          content: directText,
          assistantText: directText,
          assistantMessageId: personContextSaved?.messageId ?? null,
          mode,
          finalMode: mode,
          meta: metaForPersonContext,
          metaForSave: metaForPersonContext,
          credit: {
            ref: creditRef,
            amount: CREDIT_AMOUNT,
            authorize: authRes,
            lowWarn,
          },
        },
        { status: 200, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }
const irosResult: HandleIrosReplyOutput = await handleIrosReply({
      conversationId,
      text: userTextClean,
      hintText,
      mode,
      userCode,
      tenantId,
      rememberScope,
      reqOrigin,
      authorizationHeader: req.headers.get('authorization'),
      traceId,
      userProfile,
      style: styleInput ?? (userProfile?.style ?? null),
      history: chatHistory,
      extra: extraSoT,
    });

    // -------------------------------------------------------
    // 12.5) NORMAL BASE fallback（非FORWARDで本文が空に近い場合）
    // -------------------------------------------------------
    if (irosResult.ok) {
      const r: any = irosResult as any;

      const metaAny = r?.metaForSave ?? r?.meta ?? {};
      const extraAny = metaAny?.extra ?? {};

      const speechAct = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const allowLLM = extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;

      const finalTextPolicy = String(extraAny?.finalTextPolicy ?? '').trim().toUpperCase();
      const slotPlanPolicy = String((metaAny?.framePlan as any)?.slotPlanPolicy ?? '').trim().toUpperCase();

      const treatAsScaffoldSeed =
        finalTextPolicy.includes('TREAT_AS_SCAFFOLD_SEED') || finalTextPolicy.includes('SCAFFOLD_SEED');

      const isPdfScaffoldNoCommit =
        extraAny?.pdfScaffoldNoCommit === true ||
        finalTextPolicy === 'SLOTPLAN_SEED_SCAFFOLD' ||
        slotPlanPolicy === 'SCAFFOLD' ||
        treatAsScaffoldSeed;

      const isDiagnosisFinalSeed = finalTextPolicy === 'DIAGNOSIS_FINAL__SEED_FOR_LLM';

// -------------------------------------------------------
// NORMAL BASE fallback（非FORWARDで本文が空に近い場合）
// -------------------------------------------------------

// -------------------------------------------------------
// NORMAL BASE fallback（非FORWARDで本文が空に近い場合）
// - ✅ 非常用：LLM を呼べない（allowLLM=false）場合だけ
// - ✅ rephraseBlocks があるなら normalBase は使わない（blocks救済が正）
// -------------------------------------------------------

const candidateText = pickText(r?.content, r?.assistantText); // ← content優先
const isForward = speechAct === 'FORWARD';
const isEmptyLike = isEffectivelyEmptyText(candidateText);

// blocks があるなら「空」ではない扱い（normalBase に落とさない）
const hasRephraseBlocks =
  Array.isArray(extraAny?.rephraseBlocks) && extraAny.rephraseBlocks.length > 0;

// ✅ 非FORWARDで本文が空に近い：ただし “LLMを呼べない” ときだけ落とす
const isNonForwardButEmpty =
  !isForward &&
  allowLLM === false && // ★ここが重要：!== false ではなく === false
  String(userTextClean ?? '').trim().length > 0 &&
  isEmptyLike &&
  !hasRephraseBlocks &&
  !isPdfScaffoldNoCommit &&
  !isDiagnosisFinalSeed;

if (isNonForwardButEmpty) {
  const normal = await runNormalBase({ userText: userTextClean });

  // ✅ content を正本にする
  r.content = normal.text;
  r.assistantText = normal.text; // 互換維持
  r.text = normal.text;

  r.metaForSave = r.metaForSave ?? {};
  r.metaForSave.extra = {
    ...(r.metaForSave.extra ?? {}),
    normalBaseApplied: true,
    normalBaseSource: normal.meta.source,
    normalBaseReason: 'EMPTY_LIKE_TEXT_ALLOW_LLM_FALSE',
  };
}
    }

    if (!irosResult.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: (irosResult as any).error,
          detail: (irosResult as any).detail,
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
        { status: 500, headers: withTrace(CORS_HEADERS, traceId) },
      );
    }

    // ✅ ここで必ず取り出す
    let { result, finalMode, metaForSave, assistantText } = irosResult as any;

// -------------------------------------------------------
// SpeechPolicy: FORWARD early-return
// -------------------------------------------------------
{
  // req 由来（最優先で見る）
  const reqMeta: any = (body as any)?.meta ?? null;
  const reqExtra: any = reqMeta?.extra ?? null;

  const speechActReqRaw =
    reqExtra?.speechAct ??
    reqMeta?.speechAct ??
    (body as any)?.speechAct ??
    null;

  // iros 結果由来（従来どおり）
  const metaAny: any = metaForSave ?? (result as any)?.meta ?? {};
  const extraAny: any = metaAny?.extra ?? {};

  const speechActExtraRaw = extraAny?.speechAct;
  const speechActMetaRaw = metaAny?.speechAct;

  const speechAct0 = String(
    speechActReqRaw ?? speechActExtraRaw ?? speechActMetaRaw ?? '',
  )
    .trim()
    .toUpperCase();

  const shouldEarlyReturn = speechAct0 === 'FORWARD';

  console.info('[IROS/SPEECH_EARLY_RETURN][CHECK]', {
    body_has_meta: Boolean((body as any)?.meta),
    body_meta_extra_keys: Object.keys(((body as any)?.meta?.extra ?? {}) as any),
    traceId_used: String(traceId ?? ''),
    traceId_req: String((body as any)?.traceId ?? ''),
    conversationId: String(conversationId ?? ''),
    userCode: String(userCode ?? ''),
    speechAct_req: speechActReqRaw ?? null,
    speechAct_extra: speechActExtraRaw ?? null,
    speechAct_meta: speechActMetaRaw ?? null,
    speechAct0,
    shouldEarlyReturn,
  });

  // meta 合流（req 由来を含めて “正本 extra” を確定）
  {
    const prevExtra: any = (metaAny as any)?.extra ?? {};
    const reqExtra2: any = reqExtra ?? {};

    // ✅ reqExtra を最後に勝たせる（UI→API の指示を優先）
    const mergedExtra: any = {
      ...prevExtra,
      ...reqExtra2,
    };

    // ✅ speechAct0（最終判定）も extra に固定しておく（監査・保存の揺れ防止）
    if (speechAct0) mergedExtra.speechAct = speechAct0;

    metaAny.extra = mergedExtra;
    metaForSave = metaAny; // ✅ 以後は metaForSave を正本として扱う
  }

  if (shouldEarlyReturn) {
    let finalText = pickText((result as any)?.content, assistantText);
    finalText = String(finalText ?? '').trim();

    if (!finalText) {
      console.warn('[IROS/SPEECH_EARLY_RETURN][SKIP_EMPTY]', {
        traceId_used: String(traceId ?? ''),
        traceId_req: String((body as any)?.traceId ?? ''),
        conversationId: String(conversationId ?? ''),
        userCode: String(userCode ?? ''),
        speechAct0,
        contentLen: String((result as any)?.content ?? '').trim().length,
        assistantTextLen: String(assistantText ?? '').trim().length,
      });
    } else {
      console.info('[IROS/SPEECH_EARLY_RETURN][BYPASS_TO_NORMAL_ROUTE]', {
        traceId_used: String(traceId ?? ''),
        traceId_req: String((body as any)?.traceId ?? ''),
        conversationId: String(conversationId ?? ''),
        userCode: String(userCode ?? ''),
        speechAct0,
        finalLen: finalText.length,
        reason: 'use_normal_return_path_for_meta_consistency',
      });

      metaAny.extra = {
        ...(metaAny.extra ?? {}),
        speechEarlyReturnRequested: true,
        speechEarlyReturnBypassed: true,
        speechEarlyReturnBypassedReason: 'use_normal_return_path_for_meta_consistency',
      };
    }
  }
}
// -------------------------------------------------------
// 本文の同期（content/assistantText）
// - 正本: result.content
// -------------------------------------------------------
{
  const r: any = result;

  // ✅ content優先で確定
  const final = pickText(r?.content, assistantText);
  assistantText = final;

  if (r && typeof r === 'object') {
    // contentが空のときだけ補完（上書き事故防止）
    if (isEffectivelyEmptyText(String(r.content ?? ''))) {
      r.content = final;
    }

    r.assistantText = final; // 表示互換
  }
}


    // ✅ render-v2 の fallback 材料 SoT 同期
    {
      const final = String(assistantText ?? '').trim();

      (extraSoT as any).finalAssistantText = final;
      (extraSoT as any).finalAssistantTextCandidate = (extraSoT as any).finalAssistantTextCandidate ?? final;

      if (metaForSave && typeof metaForSave === 'object') {
        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalAssistantText: (metaForSave.extra as any)?.finalAssistantText ?? final,
          rawTextFromModel: (metaForSave.extra as any)?.rawTextFromModel ?? final,
          extractedTextFromModel: (metaForSave.extra as any)?.extractedTextFromModel ?? final,
          finalAssistantTextSyncedToExtraSoT: true,
          finalAssistantTextLen: final.length,
        };
      }
    }
    // ✅ final SHIFT / goal を route返却用 meta に再同期
    // - handleIrosReply.ts で metaForSave を揃えても、
    //   route.ts は result.meta と metaForSave を合成して返すため、
    //   ここで response用の SoT を最後に一本化する
    {
      const r: any = result && typeof result === 'object' ? result : {};
      const mfs: any =
        metaForSave && typeof metaForSave === 'object'
          ? metaForSave
          : (metaForSave = {});

      const mfsExtra: any =
        mfs.extra && typeof mfs.extra === 'object'
          ? mfs.extra
          : (mfs.extra = {});

      const resultMeta: any =
        r.meta && typeof r.meta === 'object'
          ? r.meta
          : (r.meta = {});

      const resultExtra: any =
        resultMeta.extra && typeof resultMeta.extra === 'object'
          ? resultMeta.extra
          : (resultMeta.extra = {});

      const slotPlanArr: any[] =
        (Array.isArray(resultMeta.slotPlan) ? resultMeta.slotPlan : null) ??
        (Array.isArray(mfs.slotPlan) ? mfs.slotPlan : null) ??
        (Array.isArray(r.slotPlan) ? r.slotPlan : null) ??
        [];

      const shiftSlot = slotPlanArr.find(
        (s: any) => String(s?.key ?? s?.id ?? '').trim().toUpperCase() === 'SHIFT',
      );

      const shiftText = String((shiftSlot as any)?.text ?? '').trim();

      const shiftPayload: any = (() => {
        if (!shiftText) return null;
        const m = shiftText.match(/^@SHIFT\s+(\{[\s\S]*\})$/);
        if (!m) return null;
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      })();

      const shiftKindFromShiftText = (raw: unknown): string | null => {
        const s = typeof raw === 'string' ? raw.trim() : '';
        if (!s) return null;

        const m = s.match(/^@SHIFT\s+(\{[\s\S]*\})$/);
        if (!m) return null;

        try {
          const j = JSON.parse(m[1]);
          return typeof j?.kind === 'string' && j.kind.trim()
            ? j.kind.trim()
            : null;
        } catch {
          return null;
        }
      };

      const shiftKindFromSeedBlock = (raw: unknown): string | null => {
        const s = typeof raw === 'string' ? raw : '';
        if (!s) return null;

        const line = s
          .split('\n')
          .map((v) => v.trim())
          .find((v) => v.startsWith('@SHIFT '));

        return shiftKindFromShiftText(line ?? null);
      };

      const goalKindFromShiftKind = (raw: unknown): string | null => {
        const v = String(raw ?? '').trim().toLowerCase();
        if (v === 'uncover_shift') return 'uncover';
        if (v === 'stabilize_shift') return 'stabilize';
        if (v === 'narrow_shift') return 'narrow';
        if (v === 'clarify_shift') return 'clarify';
        if (v === 'decide_shift') return 'decide';
        if (v === 'cutoff_shift' || v === 'cut_off_shift') return 'cutOff';
        return null;
      };

      const shiftKindFromGoalKind = (raw: unknown): string | null => {
        const v = String(raw ?? '').trim();
        if (v === 'uncover') return 'narrow_shift';
        if (v === 'stabilize') return 'stabilize_shift';
        if (v === 'narrow') return 'narrow_shift';
        if (v === 'clarify') return 'clarify_shift';
        if (v === 'decide') return 'decide_shift';
        if (v === 'cutOff') return 'cutoff_shift';
        return null;
      };

      const slotShiftKind =
        shiftKindFromShiftText(shiftText) ??
        shiftKindFromShiftText(String((shiftSlot as any)?.text ?? '').trim());

      const seedShiftKind =
        shiftKindFromSeedBlock(resultExtra?.llmRewriteSeed) ??
        shiftKindFromSeedBlock(mfsExtra?.llmRewriteSeed);

      const rootGoalKind =
        String(
          // ✅ compose/action などの今回ターンの意図は ctxPack / extra 側が新しい。
          // root targetKind は古い resonate が残りやすいので、最後に見る。
          mfsExtra?.ctxPack?.targetKind ??
            mfsExtra?.ctxPack?.goalKind ??
            mfsExtra?.ctxPack?.replyGoal?.kind ??
            resultExtra?.ctxPack?.targetKind ??
            resultExtra?.ctxPack?.goalKind ??
            resultExtra?.ctxPack?.replyGoal?.kind ??
            mfsExtra.goalKind ??
            resultExtra.goalKind ??
            mfs.targetKind ??
            mfs.target_kind ??
            resultMeta.targetKind ??
            resultMeta.target_kind ??
            '',
        ).trim() || null;

      const finalGoalKind =
        rootGoalKind ??
        goalKindFromShiftKind(slotShiftKind) ??
        goalKindFromShiftKind(seedShiftKind) ??
        null;

      const finalShiftKind =
        slotShiftKind ??
        seedShiftKind ??
        shiftKindFromGoalKind(finalGoalKind) ??
        null;

      if (finalGoalKind) {
        mfs.targetKind = finalGoalKind;
        mfs.target_kind = finalGoalKind;

        resultMeta.targetKind = finalGoalKind;
        resultMeta.target_kind = finalGoalKind;

        mfsExtra.targetKind = finalGoalKind;
        mfsExtra.target_kind = finalGoalKind;

        resultExtra.targetKind = finalGoalKind;
        resultExtra.target_kind = finalGoalKind;
      }

      if (finalShiftKind || finalGoalKind) {
        const nextCtxPack = {
          ...(resultExtra.ctxPack && typeof resultExtra.ctxPack === 'object'
            ? resultExtra.ctxPack
            : {}),
          ...(mfsExtra.ctxPack && typeof mfsExtra.ctxPack === 'object'
            ? mfsExtra.ctxPack
            : {}),
        };

        if (finalShiftKind) nextCtxPack.shiftKind = finalShiftKind;

        if (finalGoalKind) {
          nextCtxPack.goalKind = finalGoalKind;
          nextCtxPack.replyGoal = { kind: finalGoalKind };
        }

        mfsExtra.ctxPack = nextCtxPack;
        resultExtra.ctxPack = { ...nextCtxPack };
      }

      console.info('[IROS/ROUTE_META_SYNC][FINAL_SHIFT_TO_RESPONSE_META]', {
        traceId: traceId ?? null,
        conversationId: conversationId ?? null,
        userCode: userCode ?? null,
        finalShiftKind,
        finalGoalKind,
        root_targetKind: mfs.targetKind ?? null,
        root_target_kind: mfs.target_kind ?? null,
        extra_targetKind: mfsExtra.targetKind ?? null,
        extra_target_kind: mfsExtra.target_kind ?? null,
        ctxPack_shiftKind: mfsExtra?.ctxPack?.shiftKind ?? null,
        ctxPack_goalKind: mfsExtra?.ctxPack?.goalKind ?? null,
        ctxPack_replyGoal: mfsExtra?.ctxPack?.replyGoal ?? null,
      });
    }
    // -------------------------------------------------------
    // capture（先にここで行う：エラーでも ref を残す）
    // -------------------------------------------------------
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // headers（共通）
    const headers: Record<string, string> = withTrace(
      {
        ...CORS_HEADERS,
        'x-handler': 'app/api/agent/iros/reply',
        'x-credit-ref': creditRef,
        'x-credit-amount': String(CREDIT_AMOUNT),
        ...(lowWarn ? { 'x-warning': 'low_balance' } : {}),
      },
      traceId,
    );

    // effectiveMode（metaForSave.renderMode優先）
    const effectiveMode =
      (typeof metaForSave?.renderMode === 'string' && metaForSave.renderMode) ||
      (typeof metaForSave?.extra?.renderedMode === 'string' && metaForSave.extra.renderedMode) ||
      finalMode ||
      (result && typeof result === 'object' && typeof (result as any).mode === 'string' ? (result as any).mode : mode);

      const basePayload = {
        ok: true,
        mode: effectiveMode,
      };

    // =========================================================
    // result が object のとき
    // =========================================================
    if (result && typeof result === 'object') {
      // meta 組み立て（metaForSave優先）
      let meta: any = {
        ...(((result as any).meta) ?? {}),
        ...(metaForSave ?? {}),
        userProfile: (metaForSave as any)?.userProfile ?? (result as any)?.meta?.userProfile ?? null,
        extra: {
          ...(((result as any).meta?.extra) ?? {}),
          ...(((metaForSave as any)?.extra) ?? {}),
          userCode: userCode ?? null,
          hintText: hintText ?? null,
          traceId: traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          choiceId: extraSoT?.choiceId ?? null,
          extractedChoiceId: extraSoT?.extractedChoiceId ?? null,
          renderEngineGate: extraSoT?.renderEngineGate === true,
          renderEngine: extraSoT?.renderEngine === true,
          persistedByRoute: true,
          persistPolicy: PERSIST_POLICY,
          persistAssistantMessage: false,
        },
      };

      {
        const shiftKindNow =
          String((meta as any)?.extra?.ctxPack?.shiftKind ?? '').trim() || null;

        const pastStateTriggerKindNow =
          typeof (meta as any)?.extra?.pastStateTriggerKind === 'string'
            ? String((meta as any).extra.pastStateTriggerKind).trim()
            : null;

        // historyForWriter は内部の writer / rephrase 用の文脈でも使うため、
        // route.ts では破壊的に空配列へ上書きしない。
        // ユーザー向けレスポンスで隠す必要がある場合は、
        // handleIrosReply.ts 側の response 組み立て時にのみ制御する。
      }

      // 三軸 next step
      meta = attachNextStepMeta({
        meta,
        qCode:
          (typeof (meta as any)?.qCode === 'string' && (meta as any).qCode) ||
          (typeof (meta as any)?.q_code === 'string' && (meta as any).q_code) ||
          (typeof (meta as any)?.unified?.q?.current === 'string' && (meta as any).unified.q.current) ||
          null,
        depth:
          (typeof (meta as any)?.depth === 'string' && (meta as any).depth) ||
          (typeof (meta as any)?.depth_stage === 'string' && (meta as any).depth_stage) ||
          (typeof (meta as any)?.unified?.depth?.stage === 'string' && (meta as any).unified.depth.stage) ||
          null,
        selfAcceptance:
          typeof meta.selfAcceptance === 'number'
            ? meta.selfAcceptance
            : typeof (meta as any).self_acceptance === 'number'
              ? (meta as any).self_acceptance
              : typeof (meta as any).unified?.self_acceptance === 'number'
                ? (meta as any).unified.self_acceptance
                : null,
        hasQ5DepressRisk: false,
        userText: userTextClean,
      });

      // y/h 整数化
      meta = normalizeMetaLevels(meta);

      // memoryState（best-effort）
      let memoryStateForCtx: any | null = null;
      try {
        memoryStateForCtx = await loadIrosMemoryState(supabase as any, userCode);
      } catch {
        memoryStateForCtx = null;
      }

// meta extra merge（handle

// ✅ DEV用：header で強制 retry を有効化（本番は無効）
{
  const h = String(req.headers.get('x-iros-force-retry') ?? '').trim().toLowerCase();
  const forceRetry =
    process.env.NODE_ENV !== 'production' && (h === '1' || h === 'true' || h === 'yes' || h === 'on');

  if (forceRetry) {
    extraSoT = { ...(extraSoT ?? {}), forceRetry: true };
    meta.extra = { ...(meta.extra ?? {}), forceRetry: true };

    console.warn('[IROS/pipe][FORCE_RETRY_HEADER_ENABLED]', {
      traceId,
      conversationId,
      userCode,
      header: h,
    });
  }
}
// =========================================================
// ✅ LTM / memoryStateNoteText を extraSoT に確実に含める
// =========================================================
const userTextForForcedLtmGate = String(userTextClean ?? '').replace(/\s+/g, ' ').trim();
const compactUserTextForForcedLtmGate = userTextForForcedLtmGate.replace(
  /[\s　、。！？!?「」『』（）()]/g,
  ''
);

const shouldBlockForcedLongTermMemoryForMetaQuestion =
  /^(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(どうして|なんで|なぜ|何で).*(わかる|分かる|読める|見える|回答|答え|返答|できる|出来る)/u.test(
    compactUserTextForForcedLtmGate
  ) ||
  /^(どうして|なんで|なぜ|何で).*(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(わかる|分かる|読める|見える|回答|答え|返答|できる|出来る)/u.test(
    compactUserTextForForcedLtmGate
  ) ||
  /(Mu|mu|ム|む|IROS|iros|アイロス|Sofia|sofia|ソフィア).*(仕組み|原理|なぜ|どうして|なんで|何で).*(回答|答え|返答|わかる|分かる|できる|出来る)/u.test(
    compactUserTextForForcedLtmGate
  );

const shouldBlockForcedLongTermMemoryForScreenshotDiagnosis =
  Boolean((extraSoT as any)?.screenshotDiagnosisContext) ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        ) ||
  Boolean((extraSoT as any)?.ctxPack?.screenshotDiagnosisContext) ||
  Boolean((reqMetaRaw as any)?.extra?.screenshotDiagnosisContext);

let forcedLongTermMemory: string | null = null;

try {
  const { data: rows } = await supabase
    .from('iros_messages')
    .select('conversation_id, role, content, text, created_at')
    .eq('user_code', userCode)
    .neq('conversation_id', conversationId ?? '')
    .order('created_at', { ascending: false })
    .limit(30);

  if (Array.isArray(rows) && rows.length > 0) {
    const lastAssistant = rows.find((r: any) => {
      const role = String(r?.role ?? '').toLowerCase();
      const txt = String(r?.content ?? r?.text ?? '').trim();
      return role === 'assistant' && txt.length > 0;
    });

    if (lastAssistant) {
      const raw = String(lastAssistant.content ?? lastAssistant.text ?? '').trim();

      // ✅ LTM注入前の軽い文体サニタイズ
      // - longTermMemoryNoteText は writer / rephrase に強く影響するため、
      //   古い共鳴文体や禁止したい締め語をここで弱める。
      // - 意味は大きく変えず、表現の癖だけ落とす。
      const sanitized = raw
        .replace(/\s+/g, ' ')

        // ✅ 「〜で十分です」を単語単位で潰すと文が崩れるので、先に自然な文へ置換する
        .replace(/重くしない一文で十分です。?/g, '重くしない一文で止めるのが現実的です。')
        .replace(/短い一文で十分です。?/g, '短い一文で止めるのが現実的です。')
        .replace(/一文で十分です。?/g, '一文で止めるのが現実的です。')
        .replace(/それで十分です。?/g, 'そこで一度止めるのが現実的です。')
        .replace(/ここ一点だけで十分。?/g, 'ここだけを見れば整理しやすいです。')
        .replace(/くらいで十分です。?/g, 'くらいで止めるのが現実的です。')

        // ✅ 単独の「十分」は最後に処理する
        .replace(/十分です。?/g, 'そこで一度止めるのが現実的です。')
        .replace(/十分(?!に)。?/g, 'そこで一度止めるのが現実的です。')

        .replace(/そのままでも、話は続けられます。?/g, 'そのままでも、会話は続けられます。')
        .replace(/深度やメタが引っ込み、?/g, '')
        .replace(/表面のやりとりだけが前に出ている感じです。?/g, 'いまは表面の言葉が前に出ています。')
        .replace(/手前の言葉で十分です。?/g, 'まずは分かる言葉で返す方が扱いやすいです。')
        .replace(/あなたの位置を崩さない/g, '不安が強く出すぎない')
        .replace(/位置を崩さない/g, '不安が強く出すぎない')
        .replace(/自分の位置を崩さない/g, '不安が強く出すぎない')
        .replace(/あなたの位置まで揺れてしまう/g, '自分の価値まで揺れてしまう')
        .replace(/自分の位置まで揺れてしまう/g, '自分の価値まで揺れてしまう')
        .trim();

      const isContaminatedForcedLongTermMemory =
        /SOURCE_TEXT|PREVIOUS_EVENT_SOURCE|診断本文では|観測対象[:：]|二人の関係全体の状態として見る表現|ここで言う「?もう少しわかりやすく、詳しくして|直前スクショ診断結果|内部参照|スクショ診断Seed|writer_directives|診断内容をそのまま貼らず|いま聞かれていること/u.test(
          sanitized
        );

      if (isContaminatedForcedLongTermMemory) {
        forcedLongTermMemory = null;

        console.warn('[IROS][LTM_FORCED_LOAD_DROPPED_CONTAMINATED]', {
          conversationId,
          userCode,
          reason: 'contaminated_forced_long_term_memory',
          sanitizedHead: sanitized.slice(0, 180),
        });
      } else {
        forcedLongTermMemory = sanitized.slice(0, 220);
      }
    }
  }
} catch (e) {
  console.error('[IROS][MEMORY_LOAD_FAIL]', e);
}
// =========================================================
// 🔍 Recall Lane（キーワード検索）
// =========================================================
let recallCandidates: { text: string; created_at: string }[] = [];

try {
  // ① 単語抽出（超シンプル）
  const words = String(userTextClean ?? '')
    .replace(/[。、！？\s]/g, ' ')
    .split(' ')
    .filter((w) => w.length >= 2)
    .slice(0, 3); // 多すぎ防止

  for (const w of words) {
    const { data } = await supabase
      .from('iros_messages')
      .select('content, text, created_at')
      .eq('user_code', userCode)
      .ilike('content', `%${w}%`)
      .order('created_at', { ascending: false })
      .limit(2);

    if (Array.isArray(data) && data.length > 0) {
      for (const r of data) {
        const txt = String(r?.content ?? r?.text ?? '').trim();
        if (txt.length > 0) {
          recallCandidates.push({
            text: txt.slice(0, 200),
            created_at: r.created_at,
          });
        }
      }
    }
  }

  // 最大2件に制限
  recallCandidates = recallCandidates.slice(0, 2);
} catch (e) {
  console.error('[IROS][RECALL_FAIL]', e);
}
if (shouldBlockForcedLongTermMemoryForMetaQuestion || shouldBlockForcedLongTermMemoryForScreenshotDiagnosis) {
  forcedLongTermMemory = null;
  recallCandidates = [];

  console.log('[IROS][LTM_META_QUESTION_BLOCKED]', {
    conversationId,
    userCode,
    userTextHead: userTextForForcedLtmGate.slice(0, 120),
    droppedForcedLongTermMemory: true,
    droppedRecallCandidates: true,
  });
}

console.log(
  '[IROS][LTM_FORCED_LOAD_JSON]',
  JSON.stringify({
    conversationId,
    userCode,
    forcedLongTermMemory,
    memoryState_longTermNoteText: memoryStateForCtx?.longTermNoteText ?? null,
    shouldBlockForcedLongTermMemoryForMetaQuestion,
    shouldBlockForcedLongTermMemoryForScreenshotDiagnosis,
    final_longTermMemoryNoteText: shouldBlockForcedLongTermMemoryForMetaQuestion
      ? null
      : forcedLongTermMemory ??
        memoryStateForCtx?.longTermNoteText ??
        null,
    reqMeta_pastStateNoteText:
      (result as any)?.metaForSave?.extra?.pastStateNoteText ??
      metaForSave?.extra?.pastStateNoteText ??
      reqMetaRaw?.pastStateNoteText ??
      reqMetaRaw?.extra?.pastStateNoteText ??
      null,
  }),
);
// 🔥 recall → pastStateNote に昇格（IR診断もここで拾う）
let pastStateNoteText =
  (result as any)?.metaForSave?.extra?.pastStateNoteText ??
  metaForSave?.extra?.pastStateNoteText ??
  reqMetaRaw?.pastStateNoteText ??
  reqMetaRaw?.extra?.pastStateNoteText ??
  extraSoT?.pastStateNoteText ??
  null;

let pastStateTriggerKind =
  (result as any)?.metaForSave?.extra?.pastStateTriggerKind ??
  metaForSave?.extra?.pastStateTriggerKind ??
  reqMetaRaw?.pastStateTriggerKind ??
  reqMetaRaw?.extra?.pastStateTriggerKind ??
  null;

const shouldClearPastStateNoteForDiagnosisFollowup =
  (
    (result as any)?.metaForSave?.extra?.diagnosisFollowup === true ||
    metaForSave?.extra?.diagnosisFollowup === true ||
    Boolean((result as any)?.metaForSave?.extra?.diagnosisFollowupTargetLabel) ||
    Boolean((result as any)?.metaForSave?.extra?.ctxPack?.diagnosisFollowupTargetLabel) ||
    Boolean(metaForSave?.extra?.diagnosisFollowupTargetLabel) ||
    Boolean(metaForSave?.extra?.ctxPack?.diagnosisFollowupTargetLabel) ||
    Boolean((result as any)?.metaForSave?.extra?.lastIrDiagnosis) ||
    Boolean((result as any)?.metaForSave?.extra?.ctxPack?.lastIrDiagnosis) ||
    Boolean(metaForSave?.extra?.lastIrDiagnosis) ||
    Boolean(metaForSave?.extra?.ctxPack?.lastIrDiagnosis)
  ) &&
  (result as any)?.metaForSave?.extra?.isIrDiagnosisTurn !== true &&
  metaForSave?.extra?.isIrDiagnosisTurn !== true;

if (shouldClearPastStateNoteForDiagnosisFollowup) {
  pastStateNoteText = null;
  pastStateTriggerKind = null;

  console.log('[IROS][route] cleared pastStateNoteText for diagnosis followup', {
    targetLabel:
      (result as any)?.metaForSave?.extra?.targetLabel ??
      metaForSave?.extra?.targetLabel ??
      (result as any)?.metaForSave?.extra?.ctxPack?.targetLabel ??
      metaForSave?.extra?.ctxPack?.targetLabel ??
      null,
    hasLastIrDiagnosis: Boolean(
      (result as any)?.metaForSave?.extra?.lastIrDiagnosis ??
      (result as any)?.metaForSave?.extra?.ctxPack?.lastIrDiagnosis ??
      metaForSave?.extra?.lastIrDiagnosis ??
      metaForSave?.extra?.ctxPack?.lastIrDiagnosis
    ),
  });
}

// 👉 ここが今回の本質
if (
  !shouldBlockForcedLongTermMemoryForMetaQuestion &&
  !shouldClearPastStateNoteForDiagnosisFollowup &&
  !pastStateNoteText &&
  recallCandidates.length > 0
) {
  const topRecall = recallCandidates[0]?.text?.trim();
  if (topRecall) {
    pastStateNoteText = topRecall.slice(0, 800);
    pastStateTriggerKind = 'recent_topic';
  }
}
extraSoT = {
  ...(extraSoT ?? {}),

  // MemoryState
  memoryStateForCtx,
  memoryStateNoteText: memoryStateForCtx?.noteText ?? null,

  longTermMemoryNoteText:
    shouldBlockForcedLongTermMemoryForMetaQuestion ||
    shouldBlockForcedLongTermMemoryForScreenshotDiagnosis ||
    shouldClearPastStateNoteForDiagnosisFollowup
      ? null
      : forcedLongTermMemory ??
        memoryStateForCtx?.longTermNoteText ??
        null,

  // ✅ relationship / recall 系は writer が pastStateNoteText で読む
  pastStateNoteText,
  pastStateTriggerKind,

  recallCandidates: recallCandidates.length > 0 ? recallCandidates : null,

  // 既存の rephrase / render 指示を保持
  renderEngine: extraSoT?.renderEngine === true,
  renderEngineGate: extraSoT?.renderEngineGate === true,
};
// render engine apply（single entry）
{
  const upperMode = String(effectiveMode ?? '').toUpperCase();
  const enableRenderEngine = extraSoT?.renderEngine === true || extraSoT?.renderEngineGate === true;
  const isIT = upperMode === 'IT' || Boolean((meta as any)?.extra?.renderReplyForcedIT);
  // ✅ ir診断は render / rephrase に入れない
  const isDiagnosisFollowupForDiagnosisPersist = Boolean(
    (result as any)?.metaForSave?.extra?.diagnosisFollowup === true ||
    (result as any)?.metaForSave?.extra?.ctxPack?.diagnosisFollowup === true ||
    (result as any)?.metaForSave?.extra?.followupKind === 'deepen' ||
    (result as any)?.metaForSave?.extra?.ctxPack?.followupKind === 'deepen' ||
    (result as any)?.metaForSave?.extra?.diagnosisFollowupTargetLabel ||
    (result as any)?.metaForSave?.extra?.ctxPack?.diagnosisFollowupTargetLabel
  );

  const isIrDiagnosis =
    !isDiagnosisFollowupForDiagnosisPersist &&
    (
      (result as any)?.metaForSave?.extra?.isIrDiagnosisTurn === true ||
      (result as any)?.metaForSave?.extra?.presentationKind === 'diagnosis'
    );

    if (isIrDiagnosis) {
      const finalText = String(
        (result as any)?.content ??
          (result as any)?.assistantText ??
          (result as any)?.result?.assistantText ??
          (result as any)?.text ??
          '',
      ).trim();

const baseDiagExtraFromResultMeta =
  (((result as any)?.meta?.extra ?? {}) as any);

const baseDiagExtraFromResultMetaForSave =
  (((result as any)?.metaForSave?.extra ?? {}) as any);

const baseDiagExtraFromTopMetaForSave =
  (((metaForSave as any)?.extra ?? {}) as any);

// ✅ 診断保存では、result 側だけを正本にしない。
// handleIrosReply の top-level metaForSave 側に diagnosisHistory / activeDiagnosisId / lastIrDiagnosis が
// 入っている経路があるため、保存直前に全て合流して落とさない。
const baseDiagExtra = {
  ...(baseDiagExtraFromResultMeta && typeof baseDiagExtraFromResultMeta === 'object'
    ? baseDiagExtraFromResultMeta
    : {}),
  ...(baseDiagExtraFromResultMetaForSave && typeof baseDiagExtraFromResultMetaForSave === 'object'
    ? baseDiagExtraFromResultMetaForSave
    : {}),
  ...(baseDiagExtraFromTopMetaForSave && typeof baseDiagExtraFromTopMetaForSave === 'object'
    ? baseDiagExtraFromTopMetaForSave
    : {}),
};

const baseDiagCtxPack = {
  ...(
    baseDiagExtraFromResultMeta?.ctxPack &&
    typeof baseDiagExtraFromResultMeta.ctxPack === 'object'
      ? baseDiagExtraFromResultMeta.ctxPack
      : {}
  ),
  ...(
    baseDiagExtraFromResultMetaForSave?.ctxPack &&
    typeof baseDiagExtraFromResultMetaForSave.ctxPack === 'object'
      ? baseDiagExtraFromResultMetaForSave.ctxPack
      : {}
  ),
  ...(
    baseDiagExtraFromTopMetaForSave?.ctxPack &&
    typeof baseDiagExtraFromTopMetaForSave.ctxPack === 'object'
      ? baseDiagExtraFromTopMetaForSave.ctxPack
      : {}
  ),
};

const persistMeta = {
  ...((result as any)?.metaForSave ?? {}),
  presentationKind: 'diagnosis',
  mode: 'diagnosis',
  extra: {
    ...baseDiagExtra,
    persistedByRoute: true,
    persistPolicy: 'REPLY_SINGLE_WRITER',
    persistAssistantMessage: false,
    isIrDiagnosisTurn: true,
    presentationKind: 'diagnosis',
    mode: 'diagnosis',
    finalAssistantText: finalText,
    resolvedText: finalText,
    rawTextFromModel: finalText,
    extractedTextFromModel: finalText,
    ctxPack: {
      ...baseDiagCtxPack,
      ...(pastStateNoteText ? { pastStateNoteText } : {}),
      ...(pastStateTriggerKind ? { pastStateTriggerKind } : {}),
      ...(recallCandidates.length > 0 ? { recallCandidates } : {}),
      ...(baseDiagExtra?.irMeta && typeof baseDiagExtra.irMeta === 'object'
        ? { irMeta: baseDiagExtra.irMeta }
        : {}),
      ...(baseDiagCtxPack?.irMeta && typeof baseDiagCtxPack.irMeta === 'object'
        ? { irMeta: baseDiagCtxPack.irMeta }
        : {}),
      ...(baseDiagCtxPack?.detailMode === true || baseDiagExtra?.detailMode === true
        ? { detailMode: true }
        : {}),
    },
  },
};
try {
  const persistRes = await persistAssistantMessageToIrosMessages({
    supabase,
    conversationId,
    userCode,
    content: finalText,
    meta: persistMeta,
  });

  console.log('[IROS][DIAGNOSIS_PERSIST_RESULT]', persistRes);

  if (!persistRes || (persistRes as any).ok !== true || (persistRes as any).inserted !== true) {
    console.error('[IROS][DIAGNOSIS_PERSIST_NOT_INSERTED]', persistRes);
  } else {
    const irMetaForDiagnosisResult =
      baseDiagExtra?.irMeta ??
      baseDiagCtxPack?.irMeta ??
      null;

    const nowFlowDepthStageForDiagnosisResult = (() => {
      const flow =
        typeof (irMetaForDiagnosisResult as any)?.nowFlow === 'string'
          ? String((irMetaForDiagnosisResult as any).nowFlow)
          : typeof (irMetaForDiagnosisResult as any)?.flowA === 'string'
            ? String((irMetaForDiagnosisResult as any).flowA)
            : '';

      const match = flow.match(/^[^-]+-([A-Z][0-9]+)-/);
      return match?.[1] ?? null;
    })();

    const savedDiagnosisResult = await saveIrDiagnosisResult(supabase, {
      ownerUserCode: userCode,
      conversationId,
      messageId: (persistRes as any)?.messageId ?? null,
      targetLabel:
        irMetaForDiagnosisResult?.targetLabel ??
        baseDiagExtra?.targetLabel ??
        baseDiagCtxPack?.targetLabel ??
        null,
      drawSeed:
        irMetaForDiagnosisResult?.drawSeed ??
        baseDiagExtra?.drawSeed ??
        null,
      drawSource:
        irMetaForDiagnosisResult?.drawSource ??
        baseDiagExtra?.drawSource ??
        null,
      drawPickKey:
        irMetaForDiagnosisResult?.drawPickKey ??
        baseDiagExtra?.drawPickKey ??
        null,
      drawPickJson:
        irMetaForDiagnosisResult?.drawPickJson ??
        irMetaForDiagnosisResult?.drawPick ??
        baseDiagExtra?.drawPickJson ??
        null,
      qPrimary:
        irMetaForDiagnosisResult?.qPrimary ??
        irMetaForDiagnosisResult?.q_primary ??
        baseDiagExtra?.qPrimary ??
        baseDiagExtra?.q_code ??
        null,
      depthStage:
        irMetaForDiagnosisResult?.depthStage ??
        irMetaForDiagnosisResult?.depth_stage ??
        baseDiagExtra?.depthStage ??
        baseDiagExtra?.depth_stage ??
        nowFlowDepthStageForDiagnosisResult ??
        null,
      phase:
        irMetaForDiagnosisResult?.phase ??
        baseDiagExtra?.phase ??
        null,
      intentAnchorKey:
        irMetaForDiagnosisResult?.intentAnchorKey ??
        irMetaForDiagnosisResult?.intent_anchor_key ??
        baseDiagExtra?.intentAnchorKey ??
        baseDiagExtra?.intent_anchor_key ??
        null,
      itxStep:
        baseDiagExtra?.itxStep ??
        baseDiagExtra?.itx_step ??
        irMetaForDiagnosisResult?.itxStep ??
        irMetaForDiagnosisResult?.itx_step ??
        null,
      diagnosisText: finalText,
      diagnosisJson: {
        irMeta: irMetaForDiagnosisResult,
        baseDiagExtra,
        baseDiagCtxPack,
        persistMeta,
      },
    });

    console.log('[IROS][IR_DIAGNOSIS_RESULT_PERSIST]', savedDiagnosisResult);

    const { error: activeAtError } = await supabase
      .from('users')
      .update({
        iros_last_active_at: new Date().toISOString(),
      })
      .eq('user_code', userCode);

    if (activeAtError) {
      console.error('[IROS][ACTIVE_AT_UPDATE_ERROR]', activeAtError);
    }
  }
} catch (e) {
  console.error('[IROS][DIAGNOSIS_PERSIST_ERROR]', e);
}

return NextResponse.json({
  ok: true,
  text: finalText,
  assistant: finalText,
  meta: sanitizeIrosReplyMetaForClient(metaForSave ?? meta ?? null),
});
    }
  const isActiveContextClarification = Boolean(
    (result as any)?.gate === 'active_context_clarification' ||
      (result as any)?.result?.gate === 'active_context_clarification' ||
      (result as any)?.gate === 'pre_seed_direct_reply' ||
      (result as any)?.result?.gate === 'pre_seed_direct_reply' ||
      (result as any)?.meta?.extra?.activeContextClarification === true ||
      (result as any)?.metaForSave?.extra?.activeContextClarification === true ||
      (metaForSave as any)?.extra?.activeContextClarification === true ||
      (metaForSave as any)?.extra?.ctxPack?.activeContextClarification === true ||
      (result as any)?.meta?.extra?.preSeedDirectReply === true ||
      (result as any)?.metaForSave?.extra?.preSeedDirectReply === true ||
      (metaForSave as any)?.extra?.preSeedDirectReply === true ||
      (metaForSave as any)?.extra?.ctxPack?.preSeedDirectReply === true
  );

  if (isActiveContextClarification) {
    const finalActiveContextText = String(
      (result as any)?.content ??
        (result as any)?.assistantText ??
        (result as any)?.result?.assistantText ??
        assistantText ??
        '',
    ).trim();

    const stripRephraseCarry = (obj: any) => {
      if (!obj || typeof obj !== 'object') return;
      delete obj.rephraseBlocks;
      delete obj.rephraseHead;
      delete obj.rephrase;
      delete obj.rephraseBlocksAttached;
      delete obj.rephraseApplied;
      delete obj.rephraseLLMApplied;
      delete obj.rephraseAttachSkipped;
      delete obj.rephraseAttachReason;
      delete obj.rephraseReason;
    };

    if (finalActiveContextText) {
      assistantText = finalActiveContextText;

      if (result && typeof result === 'object') {
        (result as any).content = finalActiveContextText;
        (result as any).assistantText = finalActiveContextText;
      }

      extraSoT = {
        ...(extraSoT ?? {}),
        renderEngine: false,
        renderEngineGate: false,
        finalAssistantText: finalActiveContextText,
        finalAssistantTextCandidate: finalActiveContextText,
        rawTextFromModel: finalActiveContextText,
        extractedTextFromModel: finalActiveContextText,
        activeContextClarificationDirect: true,
      };

      stripRephraseCarry(extraSoT);

      if (meta && typeof meta === 'object') {
        meta.extra = {
          ...(meta.extra ?? {}),
          renderEngine: false,
          renderEngineGate: false,
          finalAssistantText: finalActiveContextText,
          finalAssistantTextCandidate: finalActiveContextText,
          rawTextFromModel: finalActiveContextText,
          extractedTextFromModel: finalActiveContextText,
          activeContextClarificationDirect: true,
        };
        stripRephraseCarry(meta.extra);
      }

      if (metaForSave && typeof metaForSave === 'object') {
        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          renderEngine: false,
          renderEngineGate: false,
          finalAssistantText: finalActiveContextText,
          finalAssistantTextCandidate: finalActiveContextText,
          rawTextFromModel: finalActiveContextText,
          extractedTextFromModel: finalActiveContextText,
          activeContextClarificationDirect: true,
        };
        stripRephraseCarry(metaForSave.extra);
      }
    }

    console.log('[IROS/ACTIVE_CONTEXT_CLARIFICATION][ROUTE_SKIP_RENDER]', {
      conversationId,
      userCode,
      finalLen: finalActiveContextText.length,
      finalHead: finalActiveContextText.slice(0, 80),
    });
  } else {
    const applied = await applyRenderEngineIfEnabled({
      enableRenderEngine,
      isIT,
      conversationId,
      userCode,
      userText: userTextClean,
      extraForHandle: extraSoT ?? null,
      meta,
      resultObj: result as any,
      historyMessages: Array.isArray(chatHistory) ? chatHistory : null,
      style: styleInput ?? (userProfile?.style ?? null),
    });

    meta = applied.meta;
    extraSoT = applied.extraForHandle ?? extraSoT;

    // =========================================================
    // ✅ FIX: render-v2 が付与した rephraseBlocks/head を metaForSave 側へ同期
    // - UI本文(result.content)は既に正本化済みだが、
    //   viewer/監査(/api/iros-logs)が metaForSave.meta を読む経路で rb=0 になり得るため
    // - “存在するものだけ”を同期し、空は上書きしない
    // =========================================================
    try {
      const mfs: any = metaForSave as any;
      const mfsExtra: any = (mfs?.extra ?? {}) as any;

      const metaAny: any = meta as any;
      const metaExtra: any = (metaAny?.extra ?? {}) as any;

      const sotAny: any = (extraSoT ?? {}) as any;

      const rbFromMeta =
        Array.isArray(metaExtra?.rephraseBlocks) && metaExtra.rephraseBlocks.length > 0 ? metaExtra.rephraseBlocks : null;

      const rbFromSoT =
        Array.isArray(sotAny?.rephraseBlocks) && sotAny.rephraseBlocks.length > 0 ? sotAny.rephraseBlocks : null;

      const rbFinal = rbFromMeta ?? rbFromSoT ?? null;

      const headFromMeta = String(metaExtra?.rephraseHead ?? '').trim();
      const headFromSoT = String(sotAny?.rephraseHead ?? '').trim();
      const headFinal = headFromMeta || headFromSoT || '';

      const nextExtra: any = { ...mfsExtra };

      if (rbFinal) nextExtra.rephraseBlocks = rbFinal;
      if (headFinal) nextExtra.rephraseHead = headFinal;

      // traceId もあれば寄せる（API側が meta から拾う経路の揺れを減らす）
      const traceIdFinal =
        String(metaExtra?.traceId ?? metaExtra?.trace_id ?? sotAny?.traceId ?? sotAny?.trace_id ?? '').trim() || '';
      if (traceIdFinal && !nextExtra.traceId && !nextExtra.trace_id) nextExtra.traceId = traceIdFinal;

      mfs.extra = nextExtra;
    } catch {}
  }
}
      // sanitize header
      {
        const before = String((result as any)?.content ?? '');
        const sanitized = sanitizeFinalContent(before);
        (result as any).content = sanitized.text.trimEnd();
        meta.extra = { ...(meta.extra ?? {}), finalHeaderStripped: sanitized.removed.length ? sanitized.removed : null };
      }

      // FINAL本文の確定（生成しない：strip + recoverだけ）
      {
        const curRaw = String((result as any)?.content ?? '');
        const hasSlotDirectives = /(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b/.test(curRaw);

        const exMeta: any = (metaForSave as any)?.extra ?? {};
        const exMeta2: any = (meta as any)?.extra ?? {};
        const exSoT: any = (extraSoT as any) ?? {};

        const head = String(
          exMeta?.rephraseHead ??
          exMeta2?.rephraseHead ??
          exSoT?.rephraseHead ??
          ''
        ).trim();

        const blocks: any[] = Array.isArray(exMeta?.rephraseBlocks)
          ? exMeta.rephraseBlocks
          : Array.isArray(exMeta2?.rephraseBlocks)
            ? exMeta2.rephraseBlocks
            : Array.isArray(exSoT?.rephraseBlocks)
              ? exSoT.rephraseBlocks
              : [];

              const recoveredFromBlocks = blocks.length > 0 ? blocksToText(blocks) : '';
              const recoveredText = recoveredFromBlocks || head;

        const stripSlotDirectives = (s: string) => {
          const raw = String(s ?? '');
          if (!raw) return raw;
          return raw
            .replace(/(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b[^\n]*\n?/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
        };

        const curNoSlots = hasSlotDirectives ? stripSlotDirectives(curRaw) : curRaw.trimEnd();

        let finalText =
          recoveredText && recoveredText.length > 0
            ? stripInternalLines(recoveredText).trimEnd()
            : curNoSlots;

        if (!finalText) {
          finalText = curRaw.trimEnd();
        }

        // =========================================================
        // ✅ Expression Lane（最後に適用）
        // - ここは「本文の正本(finalText)」が確定した“後”に、1行だけ前置きできる
        // - Depth/Phase/Lane の進行は変えない（表現だけ）
        // =========================================================
        try {
          const metaAny: any = meta as any;
          const extraAny: any = metaAny?.extra ?? {};

          const laneKey =
            String(
              extraAny?.intentBridge?.laneKey ??
                extraAny?.createProgressBridge?.laneKey ??
                extraAny?.laneKey ??
                extraAny?.ctxPack?.createProgressBridge?.laneKey ??
                extraAny?.ctxPack?.laneKey ??
                metaAny?.laneKey ??
                ''
            ).trim() || 'IDEA_BAND';

          const phase = (metaAny?.phase ?? metaAny?.framePlan?.phase ?? null) as any;
          const depth = (metaAny?.depth ?? metaAny?.depthStage ?? null) as any;
          const allow = (metaAny?.allow ?? extraAny?.allow ?? null) as any;

          const flowDelta =
            metaAny?.flow?.delta ?? extraAny?.ctxPack?.flow?.delta ?? extraAny?.flow?.delta ?? null;

          const returnStreak = extraAny?.ctxPack?.flow?.returnStreak ?? extraAny?.flow?.returnStreak ?? null;

          const flow = {
            flowDelta: flowDelta ?? null,
            returnStreak: returnStreak ?? null,
            ageSec: extraAny?.ctxPack?.flow?.ageSec ?? null,
            fresh: extraAny?.ctxPack?.flow?.fresh ?? null,
            sessionBreak: extraAny?.ctxPack?.flow?.sessionBreak ?? null,
          };

          const signals = (extraAny?.exprSignals ?? null) as any;

          const flags = (() => {
            const sev =
              extraAny?.stall?.severity ??
              extraAny?.stallProbe?.severity ??
              extraAny?.tConcretize?.stall?.severity ??
              extraAny?.t_concretize?.stall?.severity ??
              extraAny?.forceSwitch?.stall?.severity ??
              extraAny?.ctxPack?.stall?.severity ??
              null;
            return {
              enabled: extraAny?.exprEnabled ?? true,
              stallHard: Boolean(extraAny?.stallHard ?? (sev === 'hard')),
            };
          })();

          const d = decideExpressionLane({
            laneKey,
            phase,
            depth,
            allow,
            flow,
            signals,
            flags,
            traceId: (metaAny?.traceId ?? null) as any,
          } as any);

          const preface = String(d?.prefaceLine ?? '').trim();
          const shouldInject = d?.fired === true && preface.length > 0 && !finalText.startsWith(preface);

          if (shouldInject) {
            finalText = `${preface}\n${finalText}`.trimEnd();
          }

          metaAny.extra = {
            ...(metaAny.extra ?? {}),
            exprDecision: {
              fired: !!d?.fired,
              lane: String(d?.lane ?? 'OFF'),
              reason: String(d?.reason ?? 'DEFAULT'),
              blockedBy: (d?.blockedBy ?? null) as any,
              hasPreface: preface.length > 0,
              injectedPreface: shouldInject,
            },
          };
        } catch (e) {
          (meta as any).extra = {
            ...(((meta as any).extra ?? {}) as any),
            exprDecision: {
              fired: false,
              lane: 'OFF',
              reason: 'DEFAULT',
              blockedBy: 'ERROR',
              hasPreface: false,
              injectedPreface: false,
              error: String(e ?? ''),
            },
          };
        }

       // =========================================================
        // ✅ Iros 文体 正規化フィルタ（route: UI正本の確定点）
        // - ここで finalText を整えると、UI返却・DB保存の両方に確実に効く
        // - 重要: 正規化「後」に UI正本(result.*) を必ず再同期する
        // =========================================================
        try {
          const seed =
            String((meta as any)?.traceId ?? '') ||
            String((meta as any)?.extra?.traceId ?? '') ||
            String((metaForSave as any)?.extra?.traceId ?? '') ||
            String(conversationId ?? '');

          // ✅ 戻り値を受け取る（n が未定義で落ちていたのを修正）
                    // STYLE_NORM_FINAL_SKIP_PRESERVE_RAW_FINAL_V2
          // image_first_create の deterministic final は、この後の文体補正・practical guard で意味を変えない。
          const preserveRawFinalForStyleNorm =
            Boolean((result as any)?.meta?.extra?.preserveRawFinal) ||
            Boolean((result as any)?.meta?.extra?.skipStyleNorm) ||
            Boolean((result as any)?.meta?.extra?.imageFirstCreateFinalGuard) ||
            Boolean((meta as any)?.extra?.preserveRawFinal) ||
            Boolean((meta as any)?.extra?.skipStyleNorm) ||
            Boolean((meta as any)?.extra?.imageFirstCreateFinalGuard) ||
            Boolean((metaForSave as any)?.extra?.preserveRawFinal) ||
            Boolean((metaForSave as any)?.extra?.skipStyleNorm) ||
            Boolean((metaForSave as any)?.extra?.imageFirstCreateFinalGuard) ||
            Boolean((extraSoT as any)?.preserveRawFinal) ||
            Boolean((extraSoT as any)?.skipStyleNorm) ||
            Boolean((extraSoT as any)?.imageFirstCreateFinalGuard);

const n = preserveRawFinalForStyleNorm
            ? { text: finalText, meta: { skipped: true, reason: 'preserveRawFinal' } }
            : normalizeIrosStyleFinal(finalText, {
            seed,
            emojiKeepRate: 1.0, // 絵文字は剥がさない
            maxReplacements: 5, // ✅ 最終語彙補正を有効化。「置く」系などを自然語へ変換する
          });

          const outText = typeof (n as any)?.text === 'string' ? (n as any).text : finalText;

          // ✅ Mu practical final guard
          // - writer 指示だけでは残る禁止表現を、UI/DB保存前の最終正本で保証する。
          // - ここは表示本文だけを軽く整える。意味は変えず、古い締め癖だけ落とす。
          const practicalSafeText = preserveRawFinalForStyleNorm
            ? String(outText ?? '')
            : String(outText ?? '')
            .replace(/このくらいで十分です。?/g, '今わかっているのは、ここまでです。')
            .replace(/これくらいで十分です。?/g, '今わかっているのは、ここまでです。')
            .replace(/くらいで十分です。?/g, 'くらいまでが、今わかっていることです。')
            .replace(/それで十分です。?/g, '今わかっているのは、そこまでです。')
            .replace(/そのまま受け取っている、という一点で十分に立っています。?/g, 'そのまま受け取っている、という一点が芯です。')
            .replace(/という一点で十分に立っています。?/g, 'という一点が芯です。')
            .replace(/十分です。?/g, '今わかっているのは、ここまでです。')
            .replace(/これで足ります。?/g, '今わかっているのは、ここまでです。')
            .replace(/それで足ります。?/g, '今わかっているのは、そこまでです。')
            .replace(/で足ります。?/g, 'までが、今わかっていることです。')
            .replace(/ここで急いで意味を決めなくて大丈夫です。?/g, '今わかっているのは、まだ返事が来ていないことだけです。')
            .replace(/急いで意味を決めなくて大丈夫です。?/g, '今わかっているのは、ここまでです。')
            .replace(/今日は結論を急がなくて大丈夫です。?/g, '今わかっているのは、ここまでです。')
            .replace(/結論を急がなくて大丈夫です。?/g, '今わかっているのは、ここまでです。')
            .replace(/急いで結論を出さなくて大丈夫です。?/g, '今わかっているのは、ここまでです。')
            .replace(/ここで急いで結論を出さなくて大丈夫です。?/g, '今わかっているのは、ここまでです。')
            .replace(/自分を崩さないこと/g, 'あとで後悔しにくくすること')
            .replace(/自分を崩さない/g, 'あとで後悔しにくくする')
            .replace(/自分も崩れにくい/g, 'あとで苦しくなりにくい')
            .replace(/自分の位置を崩さない/g, '不安をぶつけすぎない')
            .replace(/あなたの位置を崩さない/g, '不安をぶつけすぎない')
            .replace(/位置を崩さない/g, '不安をぶつけすぎない')
            // ✅ Mu relationship final cleanup
            // - 恋愛・連絡不安で出やすい余分な空白、重複締めを表示前に整える。
            // - 意味は変えず、読みにくさだけ落とす。
            .replace(/\n{3,}/g, '\n\n')
            .replace(
              /今わかっているのは、まだ返事が来ていないことだけです。\s*彼の気持ちまで、ここで決まったわけではありません。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /でも、まだ返事がないだけで、彼の気持ちまで決まったわけではありません。/g,
              'でも、返事がないだけで、彼の気持ちまで決まったわけではありません。'
            )
            .replace(
              /ここで大事なのは、不安に引っぱられて結論を急がないことです。\s*彼の気持ちまで、ここで決まったわけではありません。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /ここで大事なのは、[^。]{0,80}結論を急がないことです。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /今は、「まだ来ていない」という事実と、「怖くなっている気持ち」を分けて見ていいところです。\s*不安は大きいけれど、それがそのまま結論ではありません。?[🌀\s]*/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /今わかっているのは、まだ返事が来ていないことだけです。\s*今わかっているのは、まだ返事が来ていないことだけです。/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /不安がふくらむと、沈黙そのものが答えみたいに見えてしまいます。?[🪔\s]*でも、今の段階では「返事がない」ことと「気持ちがない」ことは、まだ同じではありません。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /まだ返事が来ていない、それだけが今わかっていることです。\s*今わかっているのは、まだ返事が来ていないことだけです。?[🌀\s]*/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /今わかっているのは、まだ返事が来ていないことだけです。\s*今わかっているのは、まだ返事が来ていないことだけです。?[🌀\s]*/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /今は、彼の気持ちまで決めなくて大丈夫です。?/g,
              'でも、返事がないだけで、彼の気持ちまでここで決まったわけではありません。'
            )
            .replace(
              /まだ返事が来ていない、それだけが見えていることです。?[🌱\s]*今わかっているのは、まだ返事が来ていないことだけです。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(
              /まだ返事が来ていない、それだけが見えていることです。?/g,
              '今わかっているのは、まだ返事が来ていないことだけです。'
            )
            .replace(/話が広がっているので、いまは見るところを一つにします。?/g, '')
            // ✅ relationship_support の3文定型では、絵文字が表示ブロックを割るため落とす
            .replace(/返事が来ないと、不安になりますね。?🪔/g, '返事が来ないと、不安になりますね。')
            .replace(/でも、返事がないだけで彼の気持ちまで決まったわけではありません。?🌸/g, 'でも、返事がないだけで彼の気持ちまで決まったわけではありません。')
            .replace(/🌸\s*今わかっているのは、まだ返事が来ていないことだけです。?\s*🌀/g, '今わかっているのは、まだ返事が来ていないことだけです。')
            .replace(/🌱\s*今わかっているのは、まだ返事が来ていないことだけです。?\s*🪔/g, '今わかっているのは、まだ返事が来ていないことだけです。')
            .replace(/🌱\s*今わかっているのは、まだ返事が来ていないことだけです。?/g, '今わかっているのは、まだ返事が来ていないことだけです。')
            .replace(/今わかっているのは、まだ返事が来ていないことだけです。?\s*[🌀🪔]/g, '今わかっているのは、まだ返事が来ていないことだけです。')
            // ✅ 一部環境で 🪔 が replacement character（�）表示になるため、本文からは最終除去する
            .replace(/🪔/g, '')
            .replace(/\s*[🌱🌸🌀🪔]\s*$/g, '');

          console.info('[IROS/STYLE_NORM_FINAL]', {
            applied: !preserveRawFinalForStyleNorm,
            skipped: preserveRawFinalForStyleNorm ? 'preserveRawFinal' : null,
            meta: (n as any)?.meta,
            len_in: String(finalText ?? '').length,
            len_out: String(practicalSafeText ?? '').length,
            practicalGuardChanged: practicalSafeText !== outText,
          });

          // ✅ 正規化結果を finalText 正本へ
          finalText = practicalSafeText;

          // RELATION_OLD_SHAPE_TEMPLATE_FINAL_RESCUE
          // 恋愛・相手反応文脈で旧 image_first_create の形象テンプレが画面に出るのを最終段で止める。
          if (/(いま先に置く形は|自分の立ち位置|自分の中心|その形から外れない)/u.test(String(finalText ?? ''))) {
            finalText = [
              'いまは、気持ちを強く見せるより、相手が返しやすい小ささで動くのがいいです。',
              '',
              '送るなら、長く説明しないで一言だけにしてください。',
              '返事が軽ければ、そこで止める。',
              '相手が広げてきたら、少しだけ返す。',
              '',
              '見るのは、相手の気持ちを当てることではなく、返ってくる温度です。',
            ].join('\n');

            if (metaForSave && typeof metaForSave === 'object') {
              (metaForSave as any).extra = {
                ...(((metaForSave as any).extra ?? {}) as any),
                relationOldShapeTemplateFinalRescue: true,
                finalTextPolicy: 'FINAL_TEXT_SYNCED_RELATION_OLD_SHAPE_RESCUE',
              };
            }
          }

          // ✅ 監査用
          const metaAny2: any = meta as any;
          metaAny2.extra = {
            ...(metaAny2.extra ?? {}),
            styleNormFinal: (n as any)?.meta,
          };
        } catch (e) {
          console.warn('[IROS/STYLE_NORM_FINAL][ERROR]', {
            error: String(e ?? ''),
          });
        }

        // ✅ Internal leak guard for screenshot diagnosis
        // UI/DBへ返す直前に、内部Seed・JSON・内部見出しの露出を止める
        try {
          const leakPattern =
            /【直前スクショ診断結果|【初回スクショ診断本文】|【スクショ診断Seed】|【スクショ診断継続指示】|【ユーザーの質問】|内部参照|writer_directives|diagnosisText|screenshotDiagnosisHintText|返答方針:|現在のユーザー質問:|スクショ診断の根拠:|診断の構造メモ:|返答の前提:|SCREENSHOT_CONTEXT_V1|evidence_start|evidence_end|writer_rule=|current_user_question=|直前のスクショ診断で見えている内容|内容要約|あなたの立ち位置|あなたのどう関わるか|相手の反応|共鳴診断|ついやってしまうこと|次に見たいところ|見えている流れ:|相手側の反応:|会話の向き:|奥にある欲求:|見落としやすい点:|次に起きやすい動き:|診断後の相談では|いま聞かれていること:|^\s*["{[]|"\s*:\s*"/m;

          const hasScreenshotCtx =
            Boolean((extraSoT as any)?.screenshotDiagnosisContext) ||
        (
          String((extraSoT as any)?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.preSeedFlowDirective?.createReady)
        ) ||
        (
          String((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.flowDirection ?? '').trim() === 'place_create' &&
          Boolean((extraSoT as any)?.ctxPack?.preSeedFlowDirective?.createReady)
        ) ||
            Boolean((metaForSave as any)?.extra?.screenshotDiagnosisContext) ||
            Boolean((metaForSave as any)?.extra?.ctxPack?.screenshotDiagnosisContext);

          if (hasScreenshotCtx && leakPattern.test(String(finalText ?? ''))) {
            const screenshotHintForFallback =
              String((extraSoT as any)?.screenshotDiagnosisHintText ?? '') ||
              String((metaForSave as any)?.extra?.screenshotDiagnosisHintText ?? '') ||
              String((metaForSave as any)?.extra?.ctxPack?.screenshotDiagnosisHintText ?? '');

            const asksIfComes =
              /来ます|来る|ちゃんと来|来てくれ|会え/.test(String(userTextClean ?? ''));

            const hasArrival =
              /18:30|到着|品川|予定|予約|会う方向|現地|移動/.test(screenshotHintForFallback);

            if (asksIfComes && hasArrival) {
              finalText = [
                '来る流れに見えます。',
                '',
                '予約や到着時間など、具体的な予定の情報が出ています。',
                'なので今のスクショ上では、「来ない流れ」より「会う方向に整っている流れ」です。',
                '',
                'この流れでは、相手側にも「予定を流したくない」「早く整えたい」という温度が出ています。',
                '見るところは、来るか来ないかだけではなく、相手が自分のペースで来られる余白が残っているかです。'
              ].join('\n');
            } else if (hasArrival) {
              finalText = [
                'このスクショでは、会う方向の段取りが少しずつ整っている流れが見えます。',
                '',
                '予約や到着時間、移動や予定に関する具体的な情報が出ているので、会話は切れているというより、必要な確認をしながら進んでいます。',
                '',
                'この流れでは、相手側にも「予定を流したくない」「早く整えたい」という温度が出ています。',
                '見るべきなのは、相手が確認を急いだ理由と、こちらの確定報告を受けて安心できる流れになっているかです。'
              ].join('\n');
            } else {
              finalText = [
                'このスクショでは、相手の反応とあなたの返し方の流れが見えています。',
                '',
                '診断内容をそのまま貼るのではなく、見えている根拠だけで言うと、会話は切れているというより、必要な確認をしながら進んでいる状態です。',
                '',
                'この流れでは、相手側にも「予定を流したくない」「早く整えたい」という温度が出ています。',
                '見るべきなのは、相手が確認を急いだ理由と、こちらの確定報告を受けて安心できる流れになっているかです。'
              ].join('\n');
            }

            console.warn('[IROS/INTERNAL_LEAK_GUARD][SCREENSHOT_DIAG]', {
              traceId,
              conversationId,
              userCode,
              finalLen: finalText.length,
            });
          }
        } catch {}

        // ✅ 正規化「後」の本文を UI正本へ反映（ここがないと persist が旧本文を拾う）
        (result as any).content = finalText;
        (result as any).text = finalText;
        (result as any).assistantText = finalText;

 // ✅ metaForSave 側にも「最終本文」を同期（再発防止：meta参照経路を潰す）
 try {
  const mfs: any = metaForSave as any;
  const mfsExtra: any = (mfs?.extra ?? {}) as any;

  mfs.extra = {
    ...mfsExtra,
    // UI/DBの正本と同一にする
    resolvedText: finalText,
    finalAssistantText: finalText,
    finalAssistantTextLen: finalText.length,

    // 監査用（どこを正本にしたか）
    finalTextPolicy: 'FINAL_TEXT_SYNCED',
    finalTextPolicyPickedFrom: 'uiResultContent',
  };

  // meta 側にも明示で同期（参照の揺れを潰す）
  const metaAny: any = meta as any;
  metaAny.extra = {
    ...(metaAny.extra ?? {}),
    resolvedText: finalText,
    finalAssistantText: finalText,
  };
} catch {}



        meta.extra = {
          ...(meta.extra ?? {}),
          finalAssistantTextSynced: true,
          finalAssistantTextLen: finalText.length,
          finalTextRecoveredFromSoT: Boolean(recoveredText) ? true : undefined,
          finalTextRecoveredSource:
            Boolean(recoveredText) ? (head ? 'rephraseHead' : 'rephraseBlocks') : undefined,
          finalTextHadSlotDirectives: hasSlotDirectives ? true : undefined,
        };

      }

      // UI MODE確定（IR以外は NORMAL）
      {
        const hint = String(mode ?? '').toUpperCase();
        const eff = String(effectiveMode ?? '').toUpperCase();
        const uiMode: 'NORMAL' | 'IR' = hint.includes('IR') || eff.includes('IR') ? 'IR' : 'NORMAL';

        meta.mode = uiMode;
        meta.persistPolicy = PERSIST_POLICY;

        meta.extra = {
          ...(meta.extra ?? {}),
          uiMode,
          persistPolicy: PERSIST_POLICY,
          uiFinalTextLen: String((result as any)?.content ?? '').trim().length,
        };
      }

      // =========================================================
      // ✅ assistant 保存の“正本”決定
      // - “UIに返す本文(result.content)”を正本にする
      // - meta 参照経路は混線の温床なので、救済でも見ない（metaForSaveのみ最小限）
      // =========================================================

      const metaForSaveExtraAny: any = (metaForSave as any)?.extra ?? {};

      // ✅ UI返却の最終本文（renderGateway の最終結果がここに入る前提）
      const resultContentRaw = String((result as any)?.content ?? '').trim();

      // ✅ meta救済は「同期済み」のものだけ許可（= UI正本と同一のはずのテキストだけ）
      const resolvedUiTextRaw = (() => {
        const policy = String(metaForSaveExtraAny?.finalTextPolicy ?? '').trim();
        if (policy !== 'FINAL_TEXT_SYNCED') return '';
        return (
          String(metaForSaveExtraAny?.resolvedText ?? '').trim() ||
          String(metaForSaveExtraAny?.finalAssistantText ?? '').trim() ||
          ''
        );
      })();

      // 従来互換：assistantText/text は “混入” が起きやすいので最終手段に落とす（ただし persist では原則使わない）
      const resultAssistantOrTextRaw =
        String((result as any)?.assistantText ?? '').trim() ||
        String((result as any)?.text ?? '').trim() ||
        '';

      const resultObjFinalRaw = resultContentRaw || resultAssistantOrTextRaw || '';

      // ✅ blocks（SoT/rephrase）救済：正本が空のときだけ
      const blocksAny: unknown =
        (Array.isArray((extraSoT as any)?.rephraseBlocks) && (extraSoT as any).rephraseBlocks.length > 0
          ? (extraSoT as any).rephraseBlocks
          : metaForSaveExtraAny?.rephraseBlocks ??
            metaForSaveExtraAny?.rephrase?.blocks ??
            metaForSaveExtraAny?.rephrase?.rephraseBlocks) ?? null;

      const blocksJoined = Array.isArray(blocksAny) ? blocksToText(blocksAny as any[]) : '';
      const blocksJoinedCleaned = stripInternalLines(blocksJoined);


// ✅ persist は「UIに返した本文(result.content)」を“正本”として保存する
// - UI表示本文 = DB保存本文 を保証する
// - それ以外（rephraseBlocks / meta）は “正本が空のときだけ” の救済
const uiReturnText = stripInternalLines(resultContentRaw); // ✅ 最優先（UI返却本文）
const uiResolvedText = stripInternalLines(resolvedUiTextRaw); // ✅ 監査/救済（meta同期済の最終本文）
const fromBlocks = stripInternalLines(blocksJoinedCleaned);
const fromResultObj = stripInternalLines(resultObjFinalRaw);


// ✅ preSeed direct reply は persist 前にも result.content をロックする
// - 後段 final lock だけだと、DB保存/Training が短縮済み本文を拾う
// - ここで保存前の result.content / assistantText / meta.extra を全文へ戻す
{
  const resultAny: any = result && typeof result === 'object' ? result : null;
  const metaForSaveAny: any = metaForSave && typeof metaForSave === 'object' ? metaForSave : null;
  const mfsExtra: any =
    metaForSaveAny?.extra && typeof metaForSaveAny.extra === 'object'
      ? metaForSaveAny.extra
      : null;
  const ctxPackAny: any =
    mfsExtra?.ctxPack && typeof mfsExtra.ctxPack === 'object'
      ? mfsExtra.ctxPack
      : null;

  const preSeedAssistKindForDirectLock = String(
    mfsExtra?.preSeedAssistKind ??
      ctxPackAny?.preSeedAssistKind ??
      resultAny?.meta?.extra?.preSeedAssistKind ??
      resultAny?.metaForSave?.extra?.preSeedAssistKind ??
      ''
  ).trim();

  const shouldForceWriterForPreSeedAssist =
    preSeedAssistKindForDirectLock === 'diagnosis_followup' ||
    preSeedAssistKindForDirectLock === 'relationship_followup';

  const isPreSeedDirectReplyPrePersist =
    !shouldForceWriterForPreSeedAssist &&
    Boolean(
      resultAny?.gate === 'pre_seed_direct_reply' ||
        resultAny?.result?.gate === 'pre_seed_direct_reply' ||
        resultAny?.meta?.extra?.preSeedDirectReply === true ||
        resultAny?.metaForSave?.extra?.preSeedDirectReply === true ||
        mfsExtra?.preSeedDirectReply === true ||
        ctxPackAny?.preSeedDirectReply === true ||
        mfsExtra?.preSeedAssistKind === 'diagnosis_detail' ||
        ctxPackAny?.preSeedAssistKind === 'diagnosis_detail'
    );

  const directReplyPrePersist =
    [
      ctxPackAny?.directReplyCandidate,
      mfsExtra?.directReplyCandidate,
      ctxPackAny?.preSeedAssistDirectReply,
      mfsExtra?.preSeedAssistDirectReply,
      ctxPackAny?.preSeedAssistResult?.directReply,
      mfsExtra?.preSeedAssistResult?.directReply,
      assistantText,
    ]
      .map((v) => String(v ?? '').trim())
      .find(Boolean) ?? '';

  if (resultAny && isPreSeedDirectReplyPrePersist && directReplyPrePersist) {
    resultAny.content = directReplyPrePersist;
    resultAny.assistantText = directReplyPrePersist;
    resultAny.text = directReplyPrePersist;
    assistantText = directReplyPrePersist;

    if (metaForSaveAny) {
      metaForSaveAny.extra = {
        ...(metaForSaveAny.extra ?? {}),
        finalTextPolicy: 'FINAL_TEXT_SYNCED_PRE_PERSIST',
        resolvedText: directReplyPrePersist,
        finalAssistantText: directReplyPrePersist,
        rawTextFromModel: directReplyPrePersist,
        extractedTextFromModel: directReplyPrePersist,
        preSeedDirectReplyPrePersistLocked: true,
      };
    }

    console.log('[IROS/ROUTE_PRE_SEED_DIRECT_REPLY_PRE_PERSIST_LOCK]', {
      conversationId,
      userCode,
      finalLen: directReplyPrePersist.length,
      resultContentLen: String(resultAny.content ?? '').trim().length,
      kind: mfsExtra?.preSeedAssistKind ?? ctxPackAny?.preSeedAssistKind ?? null,
    });
  }
}

const contentForPersist = (() => {
  const fromBlocks = blocksJoinedCleaned.trim();
  const uiReturnText = stripInternalLines(
    String(
      (result as any)?.content ??
      (result as any)?.assistantText ??
      (result as any)?.text ??
      ''
    )
  ).trim();

  const uiResolvedText = stripInternalLines(
    String(
      (metaForSave as any)?.extra?.resolvedText ??
      (metaForSave as any)?.extra?.finalAssistantText ??
      ''
    )
  ).trim();

  // ✅ UIに返す正本を最優先にする
  // renderGateway / styleNorm 後の本文を優先し、rephraseBlocks は救済に戻す。
  if (!isEffectivelyEmptyText(uiReturnText) && uiReturnText.length > 0) {
    return uiReturnText;
  }

  if (!isEffectivelyEmptyText(uiResolvedText) && uiResolvedText.length > 0) {
    return uiResolvedText;
  }

  if (!isEffectivelyEmptyText(fromBlocks) && fromBlocks.length > 0) {
    return fromBlocks;
  }

  return '……';
})();

const pickedFromForLog = (() => {
  if (!isEffectivelyEmptyText(uiReturnText) && uiReturnText.length > 0) return 'uiResultContent';
  if (!isEffectivelyEmptyText(uiResolvedText) && uiResolvedText.length > 0) return 'metaResolvedUiText';
  if (!isEffectivelyEmptyText(fromBlocks) && fromBlocks.length > 0) return 'rephraseBlocks';
  if (!isEffectivelyEmptyText(fromResultObj) && fromResultObj.length > 0) return 'resultObjFinalRaw';
  return 'dots';
})();

console.info('[IROS/PERSIST_PICK]', {
  conversationId,
  userCode,
  pickedFrom: pickedFromForLog,
  pickedLen: contentForPersist.length,
  pickedHead: String(contentForPersist).slice(0, 40),

  // 参照候補の長さ（監査）
  fromResultObjLen: stripInternalLines(resultObjFinalRaw).length,
  blocksJoinedCleanedLen: blocksJoinedCleaned.length,
  resolvedUiTextLen: stripInternalLines(resolvedUiTextRaw).length,

  userEchoLen: String(userTextClean ?? '').trim().length,
  isPickedDots: contentForPersist === '……',
});


          // ✅ FINAL 確定 echo 監査（persist 直前の “最終保存本文” で判定）
          try {
            const normalizeEcho = (s: string) =>
              String(s ?? '')
                .replace(/\r\n/g, '\n')
                .replace(/\s+/g, ' ')
                .trim();

            const userEchoTrim = normalizeEcho(String(userTextClean ?? ''));
            const finalTrim = normalizeEcho(String(contentForPersist ?? ''));

            const isEchoExact = Boolean(userEchoTrim && finalTrim && userEchoTrim === finalTrim);

            const finalTextPolicy = String((metaForSave as any)?.extra?.finalTextPolicy ?? '');
            const rescuedFromRephraseMeta = Boolean((metaForSave as any)?.extra?.finalAssistantTextRescuedFromRephraseMeta);
            const rescuedFromRephrase = Boolean((metaForSave as any)?.extra?.finalAssistantTextRescuedFromRephrase);

            if (isEchoExact) {
              console.warn('[IROS/PERSIST_PICK][ECHO_DETECTED_FINAL]', {
                conversationId,
                userCode,
                pickedFrom: pickedFromForLog,
                finalTextPolicy,
                userLen: userEchoTrim.length,
                finalLen: finalTrim.length,
                userHead: userEchoTrim.slice(0, 80),
                finalHead: finalTrim.slice(0, 80),
                rescuedFromRephraseMeta,
                rescuedFromRephrase,
              });
            }
          } catch {}


          const persistStrict =
          String(process.env.IROS_PERSIST_STRICT ?? '').trim() === '1' ||
          String(process.env.NODE_ENV ?? '').trim() === 'production';

        // ✅ single-writer guard の鍵を “persist直前” に metaForSave へ必ず注入（microでもrephraseでも共通）
        try {
          const mfs: any = metaForSave as any;
          if (!mfs || typeof mfs !== 'object') {
            // metaForSave が壊れてても落とさず進める（ただし insert 側で弾かれる可能性は残る）
          } else {
            mfs.extra = {
              ...(mfs.extra ?? {}),
              persistedByRoute: true,
              persistAssistantMessage: false,
            };
          }
        } catch {}

/* =========================================
 * [置換] src/app/api/agent/iros/reply/route.ts
 * 範囲: 1320〜1404 を丸ごと置き換え
 * 目的:
 * - /reply の返却を DB 保存/Training の遅延から切り離す
 * - persist は短い timeout で best-effort
 * - training は fire-and-forget（timeout + catch）
 * ========================================= */

const withTimeout = async <T,>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; timeout: true; error: Error }> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`[TIMEOUT] ${label} ${ms}ms`));
      }, ms);
      // Node環境であればプロセス終了を妨げない
      (timer as any)?.unref?.();
    });

    const value = await Promise.race([p, timeout]);
    return { ok: true, value: value as T };
  } catch (e: any) {
    const msg = String(e?.message ?? e ?? '');
    // timeout とみなす条件（メッセージで判定）
    if (msg.includes('[TIMEOUT]')) {
      return { ok: false, timeout: true, error: e instanceof Error ? e : new Error(msg) };
    }
    return { ok: false, timeout: false as any, error: e instanceof Error ? e : new Error(msg) };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// ---- persist（best-effort / “timeoutで切らない”）
// src/app/api/agent/iros/reply/route.ts
// 範囲: 1359 行目の「const PERSIST_TIMEOUT_MS = ...」〜 下の persist エラーハンドリング末尾までを丸ごと置き換え
// 目的:
// - persistAssistantMessageToIrosMessages は内部に statement_timeout(57014) の shrink/ULTRA リトライがある
// - 外側 withTimeout で切ると「裏でinsertが走り続ける」＝二重実行/誤エラー化の温床になる
// - なので assistant persist は “最後まで待つ” を正とする（/reply は止めない）

const PERSIST_TIMEOUT_MS = (() => {
  // ※ 互換のため残す（ログ・表示用途）。assistant persist では withTimeout を使わない。
  const raw = String(process.env.IROS_PERSIST_TIMEOUT_MS ?? '15000').trim();
  const n = Number(raw);
  const ms = Number.isFinite(n) ? n : 15000;
  return Math.max(2500, Math.min(60000, Math.floor(ms)));
})();

const TRAINING_TIMEOUT_MS = Number(process.env.IROS_TRAINING_TIMEOUT_MS ?? '2500'); // training 側

let saved: any = null;

// ✅ gate: persistAssistantAllowed を尊重する（未配線なら true 扱い）
// - handleIrosReply 側が result.persistAssistantAllowed を返すようになったら、そのまま効く
const persistAssistantAllowed =
  (result as any)?.persistAssistantAllowed === false ? false : true;

{
  const tsPersistAssistant = Date.now();

  // ❌ 許可されてないなら persist しない
  if (!persistAssistantAllowed) {
    saved = {
      ok: true,
      inserted: false,
      blocked: true,
      reason: 'persistAssistantAllowed=false',
      messageId: null,
    };

    const ms = Date.now() - tsPersistAssistant;
    console.log('[IROS/persistAssistant] skipped', {
      conversationId,
      userCode,
      ms,
      reason: saved?.reason ?? null,
    });
  } else {
    try {
      // ✅ persist は “最後まで待つ”（外側 withTimeout で切らない）
      // ROUTE_FINAL_MEMORY_CTXPACK_MERGE_BEFORE_PERSIST
      // handleIrosReply側の result.metaForSave.extra.ctxPack を、保存直前の route metaForSave に合流する
      {
        const resultMetaForSave: any =
          (result as any)?.metaForSave && typeof (result as any).metaForSave === 'object'
            ? (result as any).metaForSave
            : null;

        const resultCtxPack: any =
          resultMetaForSave?.extra?.ctxPack &&
          typeof resultMetaForSave.extra.ctxPack === 'object'
            ? resultMetaForSave.extra.ctxPack
            : null;

        const mfsForPersist: any =
          metaForSave && typeof metaForSave === 'object'
            ? metaForSave
            : (metaForSave = {});

        mfsForPersist.extra =
          mfsForPersist.extra && typeof mfsForPersist.extra === 'object'
            ? mfsForPersist.extra
            : {};

        mfsForPersist.extra.ctxPack =
          mfsForPersist.extra.ctxPack && typeof mfsForPersist.extra.ctxPack === 'object'
            ? mfsForPersist.extra.ctxPack
            : {};

        if (resultCtxPack) {
          mfsForPersist.extra.ctxPack = {
            ...mfsForPersist.extra.ctxPack,
            ...resultCtxPack,
          };
        }

        // ✅ UI返却本文の正本 contentForPersist から pendingOffer を抽出して保存直前ctxPackへ乗せる
        // - 「前者/後者」「お願いします」などを次ターンで userText 単体として深掘りしないための短期正本
        // - Long Term Memory には保存しない。assistant保存meta.extra.ctxPack の current/short-lived 文脈として扱う
        {
          const finalForOffer = String(contentForPersist ?? '').trim();
          const pendingOffer = finalForOffer
            ? extractPendingOfferFromAssistantText({
                assistantText: finalForOffer,
                assistantMessageId: null,
                nowIso: new Date().toISOString(),
              })
            : null;

          if (pendingOffer) {
            mfsForPersist.extra.ctxPack.pendingOffer = pendingOffer;

            console.info('[IROS/OFFER][EXTRACT]', {
              traceId: traceId ?? null,
              conversationId: conversationId ?? null,
              userCode: userCode ?? null,
              hasPendingOffer: true,
              offerId: pendingOffer.offerId,
              kind: pendingOffer.kind,
              optionCount: pendingOffer.options.length,
              subjectLabel: pendingOffer.subject.label,
              subjectTargetKey: pendingOffer.subject.targetKey,
              subjectDomain: pendingOffer.subject.domain,
              confidence: pendingOffer.guard.confidence,
              source: 'contentForPersist',
            });
          }
        }

        console.log('[IROS/ROUTE_FINAL_MEMORY_CTXPACK_MERGE_BEFORE_PERSIST]', {
          conversationId,
          userCode,
          hasResultCtxPack: Boolean(resultCtxPack),
          hasRelationshipMemory: Boolean(mfsForPersist.extra.ctxPack.relationshipMemory),
          hasRelationshipMemoryNote:
            typeof mfsForPersist.extra.ctxPack.relationshipMemoryNote === 'string',
          hasMemorySeedText:
            typeof mfsForPersist.extra.ctxPack.memorySeedText === 'string',
          hasMemorySeedResult: Boolean(mfsForPersist.extra.ctxPack.memorySeedResult),
          relationId: mfsForPersist.extra.ctxPack.relationId ?? null,
          relationshipDisplayName:
            mfsForPersist.extra.ctxPack.relationshipDisplayName ?? null,
        });
      }

      const r = await persistAssistantMessageToIrosMessages({
        supabase,
        conversationId,
        userCode,
        content: contentForPersist,
        meta: metaForSave,
      } as any);

      saved = r; // { ok, inserted, ... }
    } catch (e) {
      saved = { ok: false, error: e };
    } finally {
      const ms = Date.now() - tsPersistAssistant;
      console.log('[IROS/persistAssistant] done', {
        conversationId,
        userCode,
        ms,
        ok: saved?.ok ?? null,
        inserted: saved?.inserted ?? null,
        blocked: saved?.blocked ?? null,
        reason: saved?.reason ?? null,
      });
    }
  }
}

if (!saved || saved.ok !== true) {
  const err: any = (saved as any)?.error ?? saved ?? null;

  console.error('[IROS/persistAssistantMessageToIrosMessages] insert error', {
    conversationId,
    userCode,
    persistStrict,
    // withTimeout を外したので、ここは “タイムアウト扱い” にしない（DB側57014は persist 本体のログに出る）
    timeoutMs: null,
    isTimeout: false,
    error: err,
  });

  meta.extra = {
    ...(meta.extra ?? {}),
    persist_failed: true,
    persist_failed_strict: persistStrict,
    persist_failed_is_timeout: false,
    persist_failed_message: String(err?.message ?? '')?.slice(0, 240) || 'persist_failed',
  };

  // ✅ 重要：/reply を止めない（strict でも throw しない）
}

const messageId = (saved as any)?.messageId ?? null;

meta.extra = {
  ...(meta.extra ?? {}),
  persistedAssistantMessage: {
    ok: Boolean(saved?.ok),
    inserted: Boolean(saved?.inserted),
    blocked: Boolean(saved?.blocked),
    reason: String(saved?.reason ?? ''),
    len: contentForPersist.length,
    pickedFrom:
      contentForPersist === '……'
        ? 'fallbackDots'
        : blocksJoinedCleaned.length > 0 && contentForPersist === blocksJoinedCleaned
          ? 'rephraseBlocks(clean)'
          : 'resultObjOrMetaPreferred',
  },
};

const preSeedAssistKindForFinalLock = String(
  (result as any)?.meta?.extra?.preSeedAssistKind ??
    (result as any)?.metaForSave?.extra?.preSeedAssistKind ??
    (metaForSave as any)?.extra?.preSeedAssistKind ??
    (metaForSave as any)?.extra?.ctxPack?.preSeedAssistKind ??
    ''
).trim();

const shouldForceWriterForFinalLock =
  preSeedAssistKindForFinalLock === 'diagnosis_followup' ||
  preSeedAssistKindForFinalLock === 'relationship_followup';

const isPreSeedDirectReplyForPostProcessing =
  !shouldForceWriterForFinalLock &&
  Boolean(
  (result as any)?.gate === 'pre_seed_direct_reply' ||
    (result as any)?.result?.gate === 'pre_seed_direct_reply' ||
    (result as any)?.meta?.extra?.preSeedDirectReply === true ||
    (result as any)?.metaForSave?.extra?.preSeedDirectReply === true ||
    (metaForSave as any)?.extra?.preSeedDirectReply === true ||
    (metaForSave as any)?.extra?.ctxPack?.preSeedDirectReply === true ||
    String((result as any)?.meta?.extra?.preSeedAssistKind ?? '').trim() === 'memory_recall_preflight_none' ||
    String((result as any)?.metaForSave?.extra?.preSeedAssistKind ?? '').trim() === 'memory_recall_preflight_none' ||
    String((metaForSave as any)?.extra?.preSeedAssistKind ?? '').trim() === 'memory_recall_preflight_none' ||
    String((metaForSave as any)?.extra?.ctxPack?.preSeedAssistKind ?? '').trim() === 'memory_recall_preflight_none'
);
if (isPreSeedDirectReplyForPostProcessing && metaForSave && typeof metaForSave === 'object') {
  (metaForSave as any).skipTraining = true;
  (metaForSave as any).skip_training = true;
  (metaForSave as any).extra = {
    ...(((metaForSave as any).extra ?? {}) as any),
    skipTraining: true,
    skip_training: true,
    skipFlowPattern: true,
    skip_flow_pattern: true,
    preSeedDirectReplyPostProcessingLocked: true,
  };
}
// FlowPatternSnapshot 保存（Phase 2-1）
// - 通常会話 chat の状態パターンを保存する
// - Production serverless でも確実に走らせるため await する
// - Similar Flow Lookup は read-only / seed logging まで確認する
const flowPatternDebug = {
  conversationId,
  userCode,
  messageId,
  savedOk: saved?.ok ?? null,
  savedInserted: saved?.inserted ?? null,
  skipFlowPattern: isPreSeedDirectReplyForPostProcessing,
  canRun:
    saved?.ok === true &&
    saved?.inserted === true &&
    messageId != null &&
    !isPreSeedDirectReplyForPostProcessing,
};

console.log('[IROS/FLOW_PATTERN_GATE]', flowPatternDebug);

if (metaForSave && typeof metaForSave === 'object') {
  (metaForSave as any).extra = {
    ...(((metaForSave as any).extra ?? {}) as any),
    flowPatternDebug,
  };
}


if (flowPatternDebug.canRun) {
  const t0 = Date.now();

  try {
    const r = await saveFlowPatternSnapshot({
      supabase,
      userCode,
      conversationId,
      messageId,
      sourceType: 'chat',
      userText: userTextClean,
      assistantText: contentForPersist,
      meta,
      metaForSave,
      tags: ['iros', 'flow_pattern', 'chat'],
    });

    const ms = Date.now() - t0;

    if (!r.ok) {
      console.error('[IROS][FlowPatternSnapshot] insert error (awaited)', {
        conversationId,
        userCode,
        messageId,
        ms,
        error: (r as any).error,
      });
      throw new Error('[IROS][FlowPatternSnapshot] insert failed; skip similar flow lookup');
    }

    console.log('[IROS][FlowPatternSnapshot] insert ok (awaited)', {
      conversationId,
      userCode,
      messageId,
      snapshotId: r.id ?? null,
      ms,
    });

    const pickFirst = (...values: unknown[]): unknown => {
      for (const value of values) {
        if (value === null || value === undefined) continue;
        if (typeof value === 'string' && value.trim() === '') continue;
        return value;
      }
      return null;
    };

    const asRouteText = (value: unknown, max = 240): string | null => {
      const text = String(value ?? '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/[ \t　]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .replace(/\n+/g, ' ');

      if (!text) return null;
      return text.length > max ? text.slice(0, max) : text;
    };

    const asRouteRecord = (value: unknown): Record<string, any> => {
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, any>)
        : {};
    };

    const metaForLookup = asRouteRecord(metaForSave ?? meta);
    const extraForLookup = asRouteRecord(metaForLookup.extra);
    const ctxPackForLookup = asRouteRecord(extraForLookup.ctxPack);
    const memoryStateSnapshotForLookup = asRouteRecord(
      pickFirst(
        ctxPackForLookup.memoryStateSnapshot,
        extraForLookup.memoryStateSnapshot,
        metaForLookup.memoryStateSnapshot,
      ),
    );
    const qCountsForLookup = asRouteRecord(
      pickFirst(
        ctxPackForLookup.qCounts,
        extraForLookup.qCounts,
        memoryStateSnapshotForLookup.qCounts,
        memoryStateSnapshotForLookup.q_counts,
      ),
    );
    const sriContextForLookup = asRouteRecord(ctxPackForLookup.sriContext);
    const sriSelfStateForLookup = asRouteRecord(sriContextForLookup.selfState);

    const similarFlowCurrentState = {
      qCode: asRouteText(
        pickFirst(
          ctxPackForLookup.qCode,
          ctxPackForLookup.q_code,
          memoryStateSnapshotForLookup.qCode,
          memoryStateSnapshotForLookup.q_code,
          metaForLookup.qCode,
          metaForLookup.q_code,
        ),
        40,
      ),
      qPrimary: asRouteText(
        pickFirst(
          ctxPackForLookup.qPrimary,
          ctxPackForLookup.q_primary,
          memoryStateSnapshotForLookup.qPrimary,
          memoryStateSnapshotForLookup.q_primary,
          qCountsForLookup.q_primary,
          qCountsForLookup.qPrimary,
          sriSelfStateForLookup.qPrimary,
          sriSelfStateForLookup.q_primary,
          extraForLookup.qPrimary,
          extraForLookup.q_primary,
          metaForLookup.qPrimary,
          metaForLookup.q_primary,
          extraForLookup.resonanceState?.qPrimary,
          extraForLookup.resonanceState?.q_primary,
          extraForLookup.mirrorFlowV1?.qPrimary,
          extraForLookup.mirrorFlowV1?.q_primary,
        ),
        40,
      ),
      eTurn: asRouteText(
        pickFirst(
          ctxPackForLookup.eTurn,
          ctxPackForLookup.e_turn,
          qCountsForLookup.e_turn_now,
          qCountsForLookup.eTurnNow,
          qCountsForLookup.e_turn,
          qCountsForLookup.eTurn,
          sriSelfStateForLookup.eTurn,
          sriSelfStateForLookup.e_turn,
          extraForLookup.e_turn,
          extraForLookup.eTurn,
          metaForLookup.e_turn,
          metaForLookup.eTurn,
          extraForLookup.resonanceState?.e_turn,
          extraForLookup.resonanceState?.eTurn,
          extraForLookup.mirrorFlowV1?.e_turn,
          extraForLookup.mirrorFlowV1?.eTurn,
          extraForLookup.mirror?.e_turn,
          extraForLookup.mirror?.eTurn,
          extraForLookup.flowMirror?.e_turn,
          extraForLookup.flowMirror?.eTurn,
        ),
        40,
      ),
      depthStage: asRouteText(
        pickFirst(
          ctxPackForLookup.depthStage,
          ctxPackForLookup.depth_stage,
          memoryStateSnapshotForLookup.depthStage,
          memoryStateSnapshotForLookup.depth_stage,
          metaForLookup.depthStage,
          metaForLookup.depth_stage,
        ),
        40,
      ),
      phase: asRouteText(
        pickFirst(
          ctxPackForLookup.phase,
          memoryStateSnapshotForLookup.phase,
          metaForLookup.phase,
        ),
        40,
      ),
    };

    const lookup = await loadSimilarFlowSnapshots({
      supabase,
      userCode,
      conversationId,
      excludeMessageId: messageId,
      excludeSnapshotId: r.id ?? null,
      sourceTypes: ['chat'],

      targetLabel: asRouteText(
        pickFirst(
          ctxPackForLookup.targetLabel,
          ctxPackForLookup.diagnosisFollowupTargetLabel,
          extraForLookup.targetLabel,
          extraForLookup.diagnosisFollowupTargetLabel,
        ),
        120,
      ),
      targetType: asRouteText(
        pickFirst(
          ctxPackForLookup.targetType,
          extraForLookup.targetType,
        ),
        80,
      ),

      qCode: asRouteText(
        pickFirst(
          ctxPackForLookup.qCode,
          ctxPackForLookup.q_code,
          memoryStateSnapshotForLookup.qCode,
          memoryStateSnapshotForLookup.q_code,
          metaForLookup.qCode,
          metaForLookup.q_code,
        ),
        40,
      ),
      qPrimary: asRouteText(
        pickFirst(
          ctxPackForLookup.qPrimary,
          ctxPackForLookup.q_primary,
          memoryStateSnapshotForLookup.qPrimary,
          memoryStateSnapshotForLookup.q_primary,
          qCountsForLookup.q_primary,
          qCountsForLookup.qPrimary,
          sriSelfStateForLookup.qPrimary,
          sriSelfStateForLookup.q_primary,
          extraForLookup.qPrimary,
          extraForLookup.q_primary,
          metaForLookup.qPrimary,
          metaForLookup.q_primary,
          extraForLookup.resonanceState?.qPrimary,
          extraForLookup.resonanceState?.q_primary,
          extraForLookup.mirrorFlowV1?.qPrimary,
          extraForLookup.mirrorFlowV1?.q_primary,
        ),
        40,
      ),
      eTurn: asRouteText(
        pickFirst(
          ctxPackForLookup.eTurn,
          ctxPackForLookup.e_turn,
          qCountsForLookup.e_turn_now,
          qCountsForLookup.eTurnNow,
          qCountsForLookup.e_turn,
          qCountsForLookup.eTurn,
          sriSelfStateForLookup.eTurn,
          sriSelfStateForLookup.e_turn,
          extraForLookup.e_turn,
          extraForLookup.eTurn,
          metaForLookup.e_turn,
          metaForLookup.eTurn,
          extraForLookup.resonanceState?.e_turn,
          extraForLookup.resonanceState?.eTurn,
          extraForLookup.mirrorFlowV1?.e_turn,
          extraForLookup.mirrorFlowV1?.eTurn,
          extraForLookup.mirror?.e_turn,
          extraForLookup.mirror?.eTurn,
          extraForLookup.flowMirror?.e_turn,
          extraForLookup.flowMirror?.eTurn,
        ),
        40,
      ),
      depthStage: asRouteText(
        pickFirst(
          ctxPackForLookup.depthStage,
          ctxPackForLookup.depth_stage,
          memoryStateSnapshotForLookup.depthStage,
          memoryStateSnapshotForLookup.depth_stage,
          metaForLookup.depthStage,
          metaForLookup.depth_stage,
        ),
        40,
      ),
      phase: asRouteText(
        pickFirst(
          ctxPackForLookup.phase,
          memoryStateSnapshotForLookup.phase,
          metaForLookup.phase,
        ),
        40,
      ),

      relationFocus: asRouteText(
        pickFirst(
          ctxPackForLookup.relationFocus,
          extraForLookup.relationFocus,
        ),
        120,
      ),
      emotionalTemperature: asRouteText(
        pickFirst(
          ctxPackForLookup.emotionalTemperature,
          extraForLookup.emotionalTemperature,
        ),
        120,
      ),

      situationTopic: asRouteText(
        pickFirst(
          ctxPackForLookup.situationTopic,
          extraForLookup.situationTopic,
          memoryStateSnapshotForLookup.situationTopic,
          userTextClean,
        ),
        160,
      ),
      situationSummary: asRouteText(
        pickFirst(
          ctxPackForLookup.situationSummary,
          extraForLookup.situationSummary,
          memoryStateSnapshotForLookup.situationSummary,
        ),
        240,
      ),

      followupKind: asRouteText(
        pickFirst(
          ctxPackForLookup.followupKind,
          extraForLookup.followupKind,
        ),
        80,
      ),
      goalKind: asRouteText(
        pickFirst(
          ctxPackForLookup.goalKind,
          ctxPackForLookup.replyGoal?.kind,
          extraForLookup.goalKind,
        ),
        80,
      ),

      keywords: [
        asRouteText(userTextClean, 120),
        asRouteText(ctxPackForLookup.situationTopic, 120),
        asRouteText(memoryStateSnapshotForLookup.situationTopic, 120),
      ].filter((v): v is string => Boolean(v)),

      recentLimit: 80,
      limit: 3,
    });

    const similarFlowSeed = buildSimilarFlowSeed({
      matches: lookup.matches,
      currentState: similarFlowCurrentState,
      limit: 3,
      maxChars: 1600,
    });

    Object.assign(flowPatternDebug, {
      snapshotOk: true,
      snapshotId: r.id ?? null,
      snapshotMs: ms,
      lookupOk: lookup.ok,
      matchesLen: lookup.matches.length,
      hasSeed: Boolean(similarFlowSeed),
      seedLen: String(similarFlowSeed ?? '').length,
      lookupError: lookup.ok ? null : String((lookup as any).error ?? ''),
    });

    console.log('[IROS/SIMILAR_FLOW_SEED]', {
      conversationId,
      userCode,
      messageId,
      snapshotId: r.id ?? null,
      ok: lookup.ok,
      matchesLen: lookup.matches.length,
      hasSeed: Boolean(similarFlowSeed),
      seedLen: String(similarFlowSeed ?? '').length,
      seedHead: String(similarFlowSeed ?? '').slice(0, 500),
    });

    console.log('[IROS/FLOW_PATTERN_LOOKUP]', {
      conversationId,
      userCode,
      messageId,
      snapshotId: r.id ?? null,
      ok: lookup.ok,
      matchesLen: lookup.matches.length,
      inputState: similarFlowCurrentState,
      similarFlowSeedLen: String(similarFlowSeed ?? '').length,
      matchesHead: lookup.matches.slice(0, 3).map((match) => ({
        id: match.id,
        score: match.score,
        reason: match.reason.slice(0, 8),
        sourceType: match.sourceType,
        qCode: match.qCode,
        qPrimary: match.qPrimary,
        eTurn: match.eTurn,
        depthStage: match.depthStage,
        phase: match.phase,
        situationTopic: match.situationTopic,
        userTextHead: match.userTextHead,
        createdAt: match.createdAt,
      })),
      error: lookup.ok ? null : (lookup as any).error,
    });
  } catch (e) {
    const ms = Date.now() - t0;
    console.error('[IROS][FlowPatternSnapshot] insert/lookup failed (awaited)', {
      conversationId,
      userCode,
      messageId,
      ms,
      error: e,
    });
  }
}

try {
  console.log('[IROS/ROUTE][FINAL_CTXPACK_WILLROTATION]', {
    traceId,
    conversationId,
    userCode,

    meta_extra_ctxPack_willRotation:
      (meta as any)?.extra?.ctxPack?.willRotation ?? null,

    metaForSave_extra_ctxPack_willRotation:
      (metaForSave as any)?.extra?.ctxPack?.willRotation ?? null,

    result_meta_extra_ctxPack_willRotation:
      (result as any)?.meta?.extra?.ctxPack?.willRotation ?? null,

    result_ctxPack_willRotation:
      (result as any)?.ctxPack?.willRotation ?? null,

    meta_extra_ctxPack_keys:
      (meta as any)?.extra?.ctxPack &&
      typeof (meta as any).extra.ctxPack === 'object'
        ? Object.keys((meta as any).extra.ctxPack)
        : null,

    metaForSave_extra_ctxPack_keys:
      (metaForSave as any)?.extra?.ctxPack &&
      typeof (metaForSave as any).extra.ctxPack === 'object'
        ? Object.keys((metaForSave as any).extra.ctxPack)
        : null,
  });
} catch {}

// training sample（skip flags）
const skipTraining =
  isPreSeedDirectReplyForPostProcessing ||
  meta?.skipTraining === true ||
  (meta as any)?.skip_training === true ||
  meta?.recallOnly === true ||
  (meta as any)?.recall_only === true ||
  (metaForSave as any)?.skipTraining === true ||
  (metaForSave as any)?.skip_training === true ||
  (metaForSave as any)?.extra?.skipTraining === true ||
  (metaForSave as any)?.extra?.skip_training === true;

if (!skipTraining) {
  const replyText = contentForPersist;

  // ✅ 返却をブロックしない：fire-and-forget（timeout + catch）
  void (async () => {
    try {
      const r = await withTimeout(
        saveIrosTrainingSample({
          supabase,
          userCode,
          tenantId,
          conversationId,
          messageId,
          inputText: userTextClean,
          replyText,
          meta,
          tags: ['iros', 'auto'],
        }),
        TRAINING_TIMEOUT_MS,
        'saveIrosTrainingSample',
      );

      if (!r.ok) {
        console.error('[IROS][Training] insert error (non-blocking)', {
          conversationId,
          userCode,
          timeoutMs: TRAINING_TIMEOUT_MS,
          isTimeout: Boolean((r as any).timeout),
          error: (r as any).error,
        });
      }
    } catch (e) {
      console.error('[IROS][Training] insert error (non-blocking)', {
        conversationId,
        userCode,
        error: e,
      });
    }
  })();
} else {
  meta.extra = {
    ...(meta.extra ?? {}),
    trainingSkipped: true,
    trainingSkipReason:
      meta?.skipTraining === true || (meta as any)?.skip_training === true ? 'skipTraining' : 'recallOnly',
  };
}
      // result 側の衝突キー除去
      // ✅ preSeed direct reply は最終返却直前で result.content をロックする
      // - handleIrosReply 側で directReply が作れていても、後段 render/slot 側で result.content が短縮されることがある
      // - UI最終返却は result.content を見るため、ここで directReply を正本として戻す
      {
        const resultAny: any = result && typeof result === 'object' ? result : null;
        const metaForSaveAny: any = metaForSave && typeof metaForSave === 'object' ? metaForSave : null;
        const mfsExtra: any =
          metaForSaveAny?.extra && typeof metaForSaveAny.extra === 'object'
            ? metaForSaveAny.extra
            : null;
        const ctxPackAny: any =
          mfsExtra?.ctxPack && typeof mfsExtra.ctxPack === 'object'
            ? mfsExtra.ctxPack
            : null;

        const isPreSeedDirectReplyFinal = Boolean(
          resultAny?.gate === 'pre_seed_direct_reply' ||
            resultAny?.result?.gate === 'pre_seed_direct_reply' ||
            resultAny?.meta?.extra?.preSeedDirectReply === true ||
            resultAny?.metaForSave?.extra?.preSeedDirectReply === true ||
            mfsExtra?.preSeedDirectReply === true ||
            ctxPackAny?.preSeedDirectReply === true ||
            mfsExtra?.preSeedAssistKind === 'diagnosis_detail' ||
            ctxPackAny?.preSeedAssistKind === 'diagnosis_detail'
        );

        const directReplyFinal =
          [
            ctxPackAny?.directReplyCandidate,
            mfsExtra?.directReplyCandidate,
            ctxPackAny?.preSeedAssistDirectReply,
            mfsExtra?.preSeedAssistDirectReply,
            ctxPackAny?.preSeedAssistResult?.directReply,
            mfsExtra?.preSeedAssistResult?.directReply,
            assistantText,
          ]
            .map((v) => String(v ?? '').trim())
            .find(Boolean) ?? '';

        if (resultAny && isPreSeedDirectReplyFinal && directReplyFinal) {
          resultAny.content = directReplyFinal;
          resultAny.assistantText = directReplyFinal;
          resultAny.text = directReplyFinal;
          assistantText = directReplyFinal;

          if (metaForSaveAny) {
            metaForSaveAny.extra = {
              ...(metaForSaveAny.extra ?? {}),
              finalTextPolicy: 'FINAL_TEXT_SYNCED',
              resolvedText: directReplyFinal,
              finalAssistantText: directReplyFinal,
              rawTextFromModel: directReplyFinal,
              extractedTextFromModel: directReplyFinal,
              preSeedDirectReplyFinalLocked: true,
            };
          }

          console.log('[IROS/ROUTE_PRE_SEED_DIRECT_REPLY_FINAL_LOCK]', {
            conversationId,
            userCode,
            finalLen: directReplyFinal.length,
            resultContentLen: String(resultAny.content ?? '').trim().length,
            kind: mfsExtra?.preSeedAssistKind ?? ctxPackAny?.preSeedAssistKind ?? null,
          });
        }
      }

      const resultObj = { ...(result as any) };
      delete (resultObj as any).mode;
      delete (resultObj as any).meta;
      delete (resultObj as any).ok;
      delete (resultObj as any).credit;

      const finalResponseText = String((result as any)?.content ?? '').trim();

      return NextResponse.json(
        {
          ok: true,
          text: finalResponseText,
          assistant: finalResponseText,
          assistantText: finalResponseText,
          content: finalResponseText,
          assistantMessageId: saved?.messageId ?? null,
          meta: sanitizeIrosReplyMetaForClient(metaForSave ?? null),
        },
        { status: 200, headers },
      );
    }

    // =========================================================
    // result が string等
    // =========================================================
    {
      const finalText = String(result ?? '').trim();
      const softened = applySoftExpression(finalText);

      return NextResponse.json(
        {
          ok: true,
          text: softened,
          meta: sanitizeIrosReplyMetaForClient(metaForSave ?? null),
        },
        { status: 200, headers },
      );
    }
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: 'internal_error', detail: String(err?.message ?? err) },
      { status: 500, headers: withTrace(CORS_HEADERS, traceIdEarly) },
    );
  }
}
