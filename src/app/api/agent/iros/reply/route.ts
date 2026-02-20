// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';

import { loadIrosUserProfile } from '@/lib/iros/server/loadUserProfile';
import { saveIrosTrainingSample } from '@/lib/iros/server/saveTrainingSample';
import { handleIrosReply, type HandleIrosReplyOutput } from '@/lib/iros/server/handleIrosReply';

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

import { attachNextStepMeta, extractNextStepChoiceFromText, findNextStepOptionById } from '@/lib/iros/nextStepOptions';
import { ensureIrosConversationUuid } from '@/lib/iros/server/ensureIrosConversationUuid';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { decideExpressionLane } from '@/lib/iros/expression/decideExpressionLane';

import { loadIrosMemoryState } from '@/lib/iros/memoryState';
import { applyRenderEngineIfEnabled } from './_impl/applyRenderEngineIfEnabled';

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
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
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

  try {
    const g = (globalThis as any)?.crypto;
    if (g?.randomUUID) return String(g.randomUUID());
  } catch {}

  return `trace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function makeTraceId(req: NextRequest, extraReq: any | null, fallbackEarly: string) {
  const fromHeader = String(req.headers.get('x-trace-id') ?? '').trim();
  if (fromHeader) return fromHeader;

  const fromExtra = String(extraReq?.traceId ?? extraReq?.trace_id ?? '').trim();
  if (fromExtra) return fromExtra;

  return fallbackEarly;
}

function stripInternalLines(s0: string) {
  const s = String(s0 ?? '');
  const lines = s.split('\n').filter((ln) => {
    const t = ln.trim();
    if (!t) return false;

    if (t.startsWith('@OBS')) return false;
    if (t.startsWith('@SHIFT')) return false;
    if (t.startsWith('@NEXT')) return false;
    if (t.startsWith('@SAFE')) return false;
    if (t.startsWith('@DRAFT')) return false;
    if (t.startsWith('@SEED_TEXT')) return false;
    if (t.startsWith('INTERNAL PACK')) return false;

    return true;
  });

  return lines.join('\n').trim();
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
    // -------------------------------------------------------
    // 1) body
    // -------------------------------------------------------
    const body = (await req.json().catch(() => ({} as any))) as IrosReplyBody;

    const conversationKeyRaw =
      typeof body?.conversationId === 'string'
        ? body.conversationId
        : typeof body?.conversation_id === 'string'
          ? body.conversation_id
          : undefined;

    const conversationKey =
      conversationKeyRaw && String(conversationKeyRaw).trim() ? String(conversationKeyRaw).trim() : undefined;

    const text = typeof body?.text === 'string' ? body.text : (body?.text as any);
    const hintText: string | undefined = (body as any)?.hintText ?? (body as any)?.modeHintText;
    const modeHintInput: string | undefined = (body as any)?.modeHint;

    const extraReq: Record<string, any> | undefined =
      (body as any)?.extra && typeof (body as any).extra === 'object' ? ((body as any).extra as Record<string, any>) : undefined;

    const traceId = makeTraceId(req, extraReq ?? null, traceIdEarly);

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
    const authRes = await authorizeChat(req, userCode, CREDIT_AMOUNT, creditRef, conversationId);

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

    // -------------------------------------------------------
    // 10) NextStep tag strip
    // -------------------------------------------------------
    const rawText = String(text ?? '');
    const extracted = extractNextStepChoiceFromText(rawText);

    const choiceIdFromExtra =
      extraReq && typeof (extraReq as any).choiceId === 'string' ? String((extraReq as any).choiceId).trim() : null;

    const extractedChoiceId =
      extracted?.choiceId && String(extracted.choiceId).trim().length > 0 ? String(extracted.choiceId).trim() : null;

    const effectiveChoiceId = choiceIdFromExtra || extractedChoiceId || null;

    const cleanText =
      extracted?.cleanText && String(extracted.cleanText).trim().length > 0 ? String(extracted.cleanText).trim() : '';

    const userTextClean = cleanText.length ? cleanText : rawText;

    if (effectiveChoiceId) findNextStepOptionById(effectiveChoiceId);

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

    // ✅ route.ts SoT extra
    let extraSoT: Record<string, any> = {
      ...sanitizedExtra,
      choiceId: effectiveChoiceId,
      extractedChoiceId,
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
    // 12) handle
    // -------------------------------------------------------
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

const candidateText = pickText(r?.content, r?.assistantText); // ← content優先
const isForward = speechAct === 'FORWARD';
const isEmptyLike = isEffectivelyEmptyText(candidateText);

const isNonForwardButEmpty =
  !isForward &&
  allowLLM !== false &&
  String(userTextClean ?? '').trim().length > 0 &&
  isEmptyLike &&
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
    normalBaseReason: 'EMPTY_LIKE_TEXT',
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
      const metaAny: any = metaForSave ?? (result as any)?.meta ?? {};
      const extraAny: any = metaAny?.extra ?? {};

      const speechAct0 = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const shouldEarlyReturn = speechAct0 === 'FORWARD';

      metaAny.extra = { ...(metaAny.extra ?? {}), ...extraAny };
      metaForSave = metaAny;

      if (shouldEarlyReturn) {
        const finalText = pickText((result as any)?.content, assistantText);
        metaAny.extra = { ...(metaAny.extra ?? {}), speechEarlyReturned: true };

        const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

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

        return NextResponse.json(
          {
            ok: true,
            mode: finalMode ?? 'auto',
            content: finalText,
            assistantText: finalText,
            credit: {
              ref: creditRef,
              amount: CREDIT_AMOUNT,
              authorize: authRes,
              capture: capRes,
              ...(lowWarn ? { warning: lowWarn } : {}),
            },
            ...(lowWarn ? { warning: lowWarn } : {}),
            meta: metaAny,
          },
          { status: 200, headers },
        );
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
      credit: {
        ref: creditRef,
        amount: CREDIT_AMOUNT,
        authorize: authRes,
        capture: capRes,
        ...(lowWarn ? { warning: lowWarn } : {}),
      },
      ...(lowWarn ? { warning: lowWarn } : {}),
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

      // meta extra merge（handle側→SoTへ寄せる）
      try {
        const metaAny = (irosResult as any)?.metaForSave ?? (irosResult as any)?.meta ?? null;
        const metaExtraA = (metaAny as any)?.extra ?? null;
        const metaExtraB = (irosResult as any)?.extraForHandle ?? null;
        const metaExtraC = (irosResult as any)?.extra ?? null;
        const metaExtraD = (irosResult as any)?.metaExtra ?? null;

        const hasObj = (x: any) => x && typeof x === 'object';

        const mergedFromMeta =
          hasObj(metaExtraA) || hasObj(metaExtraB) || hasObj(metaExtraC) || hasObj(metaExtraD)
            ? {
                ...(hasObj(metaExtraA) ? metaExtraA : {}),
                ...(hasObj(metaExtraB) ? metaExtraB : {}),
                ...(hasObj(metaExtraC) ? metaExtraC : {}),
                ...(hasObj(metaExtraD) ? metaExtraD : {}),
                ...(extraSoT ?? {}),
              }
            : null;

        if (mergedFromMeta) extraSoT = mergedFromMeta;
      } catch (e) {
        console.warn('[IROS/pipe][META_EXTRA_MERGED][ERROR]', e);
      }

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


      // render engine apply（single entry）
      // render engine apply（single entry）
      {
        const upperMode = String(effectiveMode ?? '').toUpperCase();
        const enableRenderEngine = extraSoT?.renderEngine === true || extraSoT?.renderEngineGate === true;
        const isIT = upperMode === 'IT' || Boolean((meta as any)?.extra?.renderReplyForcedIT);

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
        const curTrim = curRaw.trim();

        const emptyLike = isEffectivelyEmptyText(curTrim);
        const hasSlotDirectives = /(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b/.test(curRaw);

        const exMeta: any = (metaForSave as any)?.extra ?? {};
        const exMeta2: any = (meta as any)?.extra ?? {};
        const exSoT: any = (extraSoT as any) ?? {};

        const head = String(exMeta?.rephraseHead ?? exMeta2?.rephraseHead ?? exSoT?.rephraseHead ?? '').trim();

        const blocks: any[] = Array.isArray(exMeta?.rephraseBlocks)
          ? exMeta.rephraseBlocks
          : Array.isArray(exMeta2?.rephraseBlocks)
            ? exMeta2.rephraseBlocks
            : Array.isArray(exSoT?.rephraseBlocks)
              ? exSoT.rephraseBlocks
              : [];

        const recoveredFromBlocks = blocks.length > 0 ? blocksToText(blocks) : '';
        const recoveredText = head || recoveredFromBlocks;

        const needRecover = emptyLike || hasSlotDirectives;

        const stripSlotDirectives = (s: string) => {
          const raw = String(s ?? '');
          if (!raw) return raw;
          return raw
            .replace(/(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b[^\n]*\n?/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
        };

        const curNoSlots = hasSlotDirectives ? stripSlotDirectives(curRaw) : curRaw.trimEnd();
        const curNoSlotsTrim = curNoSlots.trim();

        let finalText = needRecover
          ? recoveredText
            ? recoveredText
            : hasSlotDirectives && curNoSlotsTrim.length > 0
              ? curNoSlots
              : curRaw.trimEnd()
          : curRaw.trimEnd();

        // =========================================================
        // ✅ Expression Lane（最後に適用）
        // - ここは「本文の正本(finalText)」が確定した“後”に、1行だけ前置きできる
        // - Depth/Phase/Lane の進行は変えない（表現だけ）
        // =========================================================
        try {
          const metaAny: any = meta as any;
          const extraAny: any = metaAny?.extra ?? {};

          const laneKey =
            String(extraAny?.intentBridge?.laneKey ?? metaAny?.laneKey ?? '').trim() || 'IDEA_BAND';

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
          finalTextRecoveredFromSoT: needRecover && Boolean(recoveredText) ? true : undefined,
          finalTextRecoveredSource:
            needRecover && Boolean(recoveredText) ? (head ? 'rephraseHead' : 'rephraseBlocks') : undefined,
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

const contentForPersist = (() => {
  if (!isEffectivelyEmptyText(uiReturnText) && uiReturnText.length > 0) return uiReturnText;
  if (!isEffectivelyEmptyText(uiResolvedText) && uiResolvedText.length > 0) return uiResolvedText;

  // 以下は “正本が空” の救済（原則ここに落ちない）
  if (!isEffectivelyEmptyText(fromBlocks) && fromBlocks.length > 0) return fromBlocks;
  if (!isEffectivelyEmptyText(fromResultObj) && fromResultObj.length > 0) return fromResultObj;

  // ❌ userEcho には落とさない（オウム再発防止）
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

      let saved: any = null;
      try {
        saved = await persistAssistantMessageToIrosMessages({
          supabase,
          conversationId,
          userCode,
          content: contentForPersist,
          meta: metaForSave,
        });
      } catch (e) {
        saved = { ok: false, error: e };
      }

      if (!saved || saved.ok !== true) {
        const err: any = (saved as any)?.error ?? saved ?? null;

        console.error('[IROS/persistAssistantMessageToIrosMessages] insert error', {
          conversationId,
          userCode,
          persistStrict,
          error: err,
        });

        meta.extra = {
          ...(meta.extra ?? {}),
          persist_failed: true,
          persist_failed_strict: persistStrict,
          persist_failed_message: String(err?.message ?? '')?.slice(0, 240) || 'persist_failed',
        };

        if (persistStrict) {
          const msg = String(err?.message ?? '') || String((saved as any)?.reason ?? '') || 'persist_failed';
          throw new Error(msg);
        }
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

      // training sample（skip flags）
      const skipTraining =
        meta?.skipTraining === true ||
        (meta as any)?.skip_training === true ||
        meta?.recallOnly === true ||
        (meta as any)?.recall_only === true;

      if (!skipTraining) {
        const replyText = contentForPersist;

        await saveIrosTrainingSample({
          supabase,
          userCode,
          tenantId,
          conversationId,
          messageId,
          inputText: userTextClean,
          replyText,
          meta,
          tags: ['iros', 'auto'],
        });
      } else {
        meta.extra = {
          ...(meta.extra ?? {}),
          trainingSkipped: true,
          trainingSkipReason:
            meta?.skipTraining === true || (meta as any)?.skip_training === true ? 'skipTraining' : 'recallOnly',
        };
      }

      // result 側の衝突キー除去
      const resultObj = { ...(result as any) };
      delete (resultObj as any).mode;
      delete (resultObj as any).meta;
      delete (resultObj as any).ok;
      delete (resultObj as any).credit;

      return NextResponse.json(
        { ...resultObj, ...basePayload, mode: effectiveMode, meta },
        { status: 200, headers },
      );
    }

    // =========================================================
    // result が string等
    // =========================================================
    {
      const finalText = String(result ?? '').trim();

      const metaString: any = {
        userProfile: userProfile ?? null,
        extra: {
          userCode,
          hintText,
          traceId,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          persistedByRoute: true,
          persistPolicy: PERSIST_POLICY,
          persistAssistantMessage: false,
          renderEngineGate: extraSoT?.renderEngineGate === true,
          renderEngine: extraSoT?.renderEngine === true,
        },
      };

      return NextResponse.json(
        { ...basePayload, content: finalText, meta: metaString },
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
