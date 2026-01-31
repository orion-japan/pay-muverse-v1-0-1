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

import { buildResonanceVector } from '@/lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { loadIrosMemoryState } from '@/lib/iros/memoryState';
import { maybeAttachRephraseForRenderV2 } from './_impl/rephrase';

import {
  pickUserCode,
  pickSilenceReason,
  pickSpeechAct,
  isEffectivelyEmptyText,
  inferUIMode,
  inferUIModeReason,
  sanitizeFinalContent,
  normalizeMetaLevels,
} from './_helpers';
import type { ReplyUIMode } from './_helpers';

import {
  pickText,
  pickFallbackAssistantText,
  normalizeHistoryMessages,
  buildFallbackRenderBlocksFromFinalText,
  type RenderBlock,
} from './_impl/utils';

// =========================================================
// CORS
// =========================================================
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-user-code, x-credit-cost',
} as const;

// 既定：1往復 = 5pt（ENVで上書き可）
const CHAT_CREDIT_AMOUNT = Number(process.env.IROS_CHAT_CREDIT_AMOUNT ?? 5);

// 残高しきい値（ENVで上書き可）
const LOW_BALANCE_THRESHOLD = Number(process.env.IROS_LOW_BALANCE_THRESHOLD ?? 10);

const PERSIST_POLICY = 'REPLY_SINGLE_WRITER' as const;

// service-role supabase（残高チェック + 訓練用保存 + assistant保存）
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL is missing');
}
if (!SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_SERVICE_ROLE_KEY is missing (service-role required)');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// =========================================================
// OPTIONS
// =========================================================
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// =========================================================
// POST
// =========================================================
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  // ✅ 早期returnでも必ず traceId を返す（body未読でも使える）
  const traceIdEarly = (() => {
    const fromHeader = req.headers.get('x-trace-id');
    const s = String(fromHeader ?? '').trim();
    if (s) return s;

    try {
      const g = (globalThis as any)?.crypto;
      if (g?.randomUUID) return String(g.randomUUID());
    } catch {}

    return `trace_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  })();

  try {
    // 1) auth
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1';
    const hUserCode = req.headers.get('x-user-code');
    const bypassUserCode = hUserCode && hUserCode.trim().length > 0 ? hUserCode.trim() : null;

    let auth: any = null;
    if (DEV_BYPASS && bypassUserCode) {
      auth = { ok: true, userCode: bypassUserCode, uid: 'dev-bypass' };
    } else {
      auth = await verifyFirebaseAndAuthorize(req);
      if (!auth?.ok) {
        const headers: Record<string, string> = { ...CORS_HEADERS };
        headers['x-trace-id'] = String(traceIdEarly);
        return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers });
      }
    }

    // 2) body
    const body = await req.json().catch(() => ({} as any));
    const conversationId: string | undefined = body?.conversationId;
    const text: string | undefined = body?.text;
    const hintText: string | undefined = body?.hintText ?? body?.modeHintText;
    const modeHintInput: string | undefined = body?.modeHint;
    const extraReq: Record<string, any> | undefined = body?.extra;

    // ✅ body側の traceId があれば優先し、無ければ early を使う（ここで確定）
    const traceId = (() => {
      const fromExtra = extraReq?.traceId ?? extraReq?.trace_id ?? null;
      const s = String(fromExtra ?? traceIdEarly ?? '').trim();
      return s || String(traceIdEarly);
    })();

    const chatHistory: unknown[] | undefined = Array.isArray(body?.history) ? (body.history as unknown[]) : undefined;

    const styleInput: string | undefined =
      typeof body?.style === 'string'
        ? body.style
        : typeof body?.styleHint === 'string'
          ? body.styleHint
          : undefined;

    if (!conversationId || !text) {
      const headers: Record<string, string> = { ...CORS_HEADERS };
      headers['x-trace-id'] = String(traceId);
      return NextResponse.json(
        { ok: false, error: 'bad_request', detail: 'conversationId and text are required' },
        { status: 400, headers },
      );
    }

    const tenantId: string =
      typeof body?.tenant_id === 'string' && body.tenant_id.trim().length > 0
        ? body.tenant_id.trim()
        : typeof body?.tenantId === 'string' && body.tenantId.trim().length > 0
          ? body.tenantId.trim()
          : 'default';

    // 3) mode
    const mode = resolveModeHintFromText({ modeHint: modeHintInput, hintText, text });
    const rememberScope: RememberScopeKind | null = resolveRememberScope({ modeHint: modeHintInput, hintText, text });

    // 4) ids
    const userCode = pickUserCode(req, auth);
    if (!userCode) {
      return NextResponse.json({ ok: false, error: 'unauthorized_user_code_missing' }, { status: 401, headers: CORS_HEADERS });
    }

    // 5) credit amount（body.cost → header → default）
    const headerCost = req.headers.get('x-credit-cost');
    const bodyCost = body?.cost;
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

    // 6) authorize
    const authRes = await authorizeChat(req, userCode, CREDIT_AMOUNT, creditRef, conversationId);
    if (!authRes.ok) {
      const errCode = (authRes as any).error ?? 'credit_authorize_failed';
      const res = NextResponse.json(
        { ok: false, error: errCode, credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes } },
        { status: 402, headers: CORS_HEADERS },
      );
      res.headers.set('x-reason', String(errCode));
      res.headers.set('x-user-code', userCode);
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));
      res.headers.set('x-trace-id', String(traceId));
      return res;
    }

    // 7) low balance warn
    let lowWarn: null | { code: 'low_balance'; balance: number; threshold: number } = null;
    if (Number.isFinite(LOW_BALANCE_THRESHOLD) && LOW_BALANCE_THRESHOLD > 0) {
      const { data: balRow, error: balErr } = await supabase
        .from('users')
        .select('sofia_credit')
        .eq('user_code', userCode)
        .maybeSingle();

      if (!balErr && balRow && balRow.sofia_credit != null) {
        const balance = Number(balRow.sofia_credit) || 0;
        if (balance < LOW_BALANCE_THRESHOLD) {
          lowWarn = { code: 'low_balance', balance, threshold: LOW_BALANCE_THRESHOLD };
        }
      }
    }

    // 8) user profile（best-effort）
    let userProfile: any | null = null;
    try {
      userProfile = await loadIrosUserProfile(supabase, userCode);
    } catch {
      userProfile = null;
    }

    // 9) NextStep tag strip
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

    if (effectiveChoiceId) {
      findNextStepOptionById(effectiveChoiceId);
    }

    // 10) extra sanitize（route.tsでIT強制は扱わない）
    const rawExtra: Record<string, any> = (extraReq ?? {}) as any;
    const sanitizedExtra: Record<string, any> = { ...rawExtra };

    delete (sanitizedExtra as any).forceIT;
    delete (sanitizedExtra as any).renderMode;
    delete (sanitizedExtra as any).spinLoop;
    delete (sanitizedExtra as any).descentGate;
    delete (sanitizedExtra as any).tLayerModeActive;
    delete (sanitizedExtra as any).tLayerHint;

    // ✅ route.ts の SoT extra（この変数だけを “正” とする）
    let extraSoT: Record<string, any> = {
      ...sanitizedExtra,
      choiceId: effectiveChoiceId,
      extractedChoiceId,
      traceId, // route.ts が source-of-truth の traceId
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
      persistAssistantMessage: false,
    };

    // 11) handle
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

    // 11.5) NORMAL BASE fallback（非SILENCE/FORWARDで本文が空に近い場合）
    if (irosResult.ok) {
      const r: any = irosResult as any;
      const metaAny = r?.metaForSave ?? r?.meta ?? {};
      const extraAny = metaAny?.extra ?? {};
      const speechAct = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const allowLLM = extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;

      const slotPlanPolicy = String((metaAny?.framePlan as any)?.slotPlanPolicy ?? '').trim().toUpperCase();
      const finalTextPolicy = String(extraAny?.finalTextPolicy ?? '').trim().toUpperCase();

      const treatAsScaffoldSeed = finalTextPolicy.includes('TREAT_AS_SCAFFOLD_SEED') || finalTextPolicy.includes('SCAFFOLD_SEED');

      const isPdfScaffoldNoCommit =
        extraAny?.pdfScaffoldNoCommit === true ||
        finalTextPolicy === 'SLOTPLAN_SEED_SCAFFOLD' ||
        slotPlanPolicy === 'SCAFFOLD' ||
        treatAsScaffoldSeed;

      const llmRewriteSeedLen = String(extraAny?.llmRewriteSeed ?? '').trim().length;

      // ✅ SKIPは「診断で明示されたseed運用」のときだけ
      const isDiagnosisFinalSeed = finalTextPolicy === 'DIAGNOSIS_FINAL__SEED_FOR_LLM';

      const candidateText = pickText(r?.assistantText, r?.content);
      const isSilenceOrForward = speechAct === 'SILENCE' || speechAct === 'FORWARD';
      const isEmptyLike = isEffectivelyEmptyText(candidateText);

      const isNonSilenceButEmpty =
        !isSilenceOrForward &&
        allowLLM !== false &&
        String(userTextClean ?? '').trim().length > 0 &&
        isEmptyLike &&
        !isPdfScaffoldNoCommit &&
        !isDiagnosisFinalSeed;

      if (isNonSilenceButEmpty) {
        const normal = await runNormalBase({ userText: userTextClean });
        r.assistantText = normal.text;
        r.content = normal.text;
        r.text = normal.text;

        r.metaForSave = r.metaForSave ?? {};
        r.metaForSave.extra = {
          ...(r.metaForSave.extra ?? {}),
          normalBaseApplied: true,
          normalBaseSource: normal.meta.source,
          normalBaseReason: 'EMPTY_LIKE_TEXT',
        };
      } else if (isPdfScaffoldNoCommit && isEmptyLike) {
        console.log('[IROS/NormalBase][SKIP] scaffold no-commit (expected empty body)', {
          conversationId,
          userCode,
          speechAct,
          slotPlanPolicy: slotPlanPolicy || null,
          finalTextPolicy: finalTextPolicy || null,
          pdfScaffoldNoCommit: extraAny?.pdfScaffoldNoCommit ?? null,
        });
      } else if (isDiagnosisFinalSeed && isEmptyLike) {
        console.log('[IROS/NormalBase][SKIP] diagnosis final seed (expected empty body)', {
          conversationId,
          userCode,
          speechAct,
          slotPlanPolicy: slotPlanPolicy || null,
          finalTextPolicy: finalTextPolicy || null,
          llmRewriteSeedLen,
        });
      }
    }

    if (!irosResult.ok) {
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        'x-credit-ref': creditRef,
        'x-credit-amount': String(CREDIT_AMOUNT),
        'x-trace-id': String(traceId),
      };

      return NextResponse.json(
        { ok: false, error: (irosResult as any).error, detail: (irosResult as any).detail, credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes } },
        { status: 500, headers },
      );
    }

    // ✅ ここで必ず取り出す（以降は finalMode/assistantText を参照しても安全）
    let { result, finalMode, metaForSave, assistantText } = irosResult as any;

    // =========================================================
    // ✅ Meta/Extra: SpeechPolicy early-return + render-v2 gate clamp
    // =========================================================
    {
      const metaAny: any = metaForSave ?? (result as any)?.meta ?? {};
      const extraAny: any = metaAny?.extra ?? {};

      const env = String(process.env.IROS_RENDER_EXPAND_ENABLED ?? 'true').toLowerCase().trim();
      const EXPAND_ENABLED = ['1', 'true', 'on', 'yes', 'enabled'].includes(env);

      const speechAct0 = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const isSilenceOrForward0 = speechAct0 === 'SILENCE' || speechAct0 === 'FORWARD';

      const mode0 = String(finalMode ?? metaAny?.mode ?? '').toLowerCase();
      const isIR0 = mode0.includes('ir');

      const expandAllowed = EXPAND_ENABLED && !isSilenceOrForward0 && !isIR0;

      extraAny.expandAllowed = expandAllowed;

      if (expandAllowed) {
        const expandedMax = 16;
        extraAny.maxLinesHint =
          typeof extraAny?.maxLinesHint === 'number'
            ? Math.max(extraAny.maxLinesHint, expandedMax)
            : expandedMax;
      }

      metaAny.extra = { ...(metaAny.extra ?? {}), ...extraAny };
      metaForSave = metaAny;

      const speechAct = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const shouldEarlyReturn = speechAct === 'SILENCE' || speechAct === 'FORWARD';

      if (shouldEarlyReturn) {
        const finalText = pickText((result as any)?.content, assistantText);
        metaAny.extra = { ...(metaAny.extra ?? {}), speechEarlyReturned: true };

        const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

        const headers: Record<string, string> = {
          ...CORS_HEADERS,
          'x-handler': 'app/api/agent/iros/reply',
          'x-credit-ref': creditRef,
          'x-credit-amount': String(CREDIT_AMOUNT),
          ...(lowWarn ? { 'x-warning': 'low_balance' } : {}),
          'x-trace-id': String(traceId),
        };

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

    // 本文の同期（content/assistantText/text）
    {
      const r: any = result;
      const final = pickText(r?.assistantText, r?.content, r?.text, assistantText);
      assistantText = final;
      if (r && typeof r === 'object') {
        r.content = final;
        r.assistantText = final;
        r.text = final;
      }
    }

    // ✅ render-v2 の fallback 材料は SoT extra を参照するため、最終本文を同期（SoTを満たす）
    {
      const final = String(assistantText ?? '').trim();

      (extraSoT as any).finalAssistantText = final;
      (extraSoT as any).finalAssistantTextCandidate = (extraSoT as any).finalAssistantTextCandidate ?? final;

      (extraSoT as any).assistantText = (extraSoT as any).assistantText ?? final;
      (extraSoT as any).resolvedText = (extraSoT as any).resolvedText ?? final;

      (extraSoT as any).rawTextFromModel = (extraSoT as any).rawTextFromModel ?? final;
      (extraSoT as any).extractedTextFromModel = (extraSoT as any).extractedTextFromModel ?? final;

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

    // capture
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // headers
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
      ...(lowWarn ? { 'x-warning': 'low_balance' } : {}),
      'x-trace-id': String(traceId),
    };

    // effectiveMode（metaForSave.renderMode優先）
    const effectiveMode =
      (typeof metaForSave?.renderMode === 'string' && metaForSave.renderMode) ||
      (typeof metaForSave?.extra?.renderedMode === 'string' && metaForSave.extra.renderedMode) ||
      finalMode ||
      (result && typeof result === 'object' && typeof (result as any).mode === 'string'
        ? (result as any).mode
        : mode);

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
      // meta 組み立て（✅ metaForSave優先：result.meta → metaForSave の順で上書き）
      let meta: any = {
        ...(((result as any).meta) ?? {}),
        ...(metaForSave ?? {}),
        userProfile: (metaForSave as any)?.userProfile ?? (result as any)?.meta?.userProfile ?? userProfile ?? null,
        extra: {
          ...(((result as any).meta?.extra) ?? {}),
          ...(((metaForSave as any)?.extra) ?? {}),

          userCode: userCode ?? null,
          hintText: hintText ?? null,
          traceId: traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          choiceId: extraSoT?.choiceId ?? null,
          extractedChoiceId: extraSoT?.extractedChoiceId ?? null,

          // ✅ routeで確定した gate を meta にも同期（判定ブレ防止）
          renderEngineGate: extraSoT?.renderEngineGate === true,
          renderEngine: extraSoT?.renderEngine === true,

          persistedByRoute: true,
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
            : typeof meta.self_acceptance === 'number'
              ? meta.self_acceptance
              : typeof meta.unified?.self_acceptance === 'number'
                ? meta.unified.self_acceptance
                : null,
        hasQ5DepressRisk: false,
        userText: userTextClean,
      });

      // y/h 整数化
      meta = normalizeMetaLevels(meta);

      // rephrase 前に memoryState を読む（last_state）
      let memoryStateForCtx: any | null = null;
      try {
        memoryStateForCtx = await loadIrosMemoryState(supabase as any, userCode);
      } catch {
        memoryStateForCtx = null;
      }

      // ✅ handleIrosReply 側で付いた meta.extra / extra を SoT に吸収（SoT優先で壊さない）
      // - ただし “SoTの上書き” はしない：SoTを最後にマージする
      try {
        const metaAny = (irosResult as any)?.metaForSave ?? (irosResult as any)?.meta ?? null;

        const metaExtraA = (metaAny as any)?.extra ?? null;
        const metaExtraB = (irosResult as any)?.extraForHandle ?? null;
        const metaExtraC = (irosResult as any)?.extra ?? null;
        const metaExtraD = (irosResult as any)?.metaExtra ?? null;

        const hasObj = (x: any) => x && typeof x === 'object';

        const mergedFromMeta =
          (hasObj(metaExtraA) || hasObj(metaExtraB) || hasObj(metaExtraC) || hasObj(metaExtraD))
            ? {
                ...(hasObj(metaExtraA) ? metaExtraA : {}),
                ...(hasObj(metaExtraB) ? metaExtraB : {}),
                ...(hasObj(metaExtraC) ? metaExtraC : {}),
                ...(hasObj(metaExtraD) ? metaExtraD : {}),
                ...(extraSoT ?? {}),
              }
            : null;

        if (mergedFromMeta) {
          extraSoT = mergedFromMeta;

          const blocks =
            (metaExtraB as any)?.rephraseBlocks ??
            (metaExtraB as any)?.rephrase?.blocks ??
            (metaExtraB as any)?.rephrase?.rephraseBlocks ??
            (metaExtraA as any)?.rephraseBlocks ??
            (metaExtraA as any)?.rephrase?.blocks ??
            (metaExtraA as any)?.rephrase?.rephraseBlocks ??
            (metaExtraC as any)?.rephraseBlocks ??
            (metaExtraC as any)?.rephrase?.blocks ??
            (metaExtraC as any)?.rephrase?.rephraseBlocks ??
            (metaExtraD as any)?.rephraseBlocks ??
            (metaExtraD as any)?.rephrase?.blocks ??
            (metaExtraD as any)?.rephrase?.rephraseBlocks ??
            null;

          if (!Array.isArray((extraSoT as any).rephraseBlocks) && Array.isArray(blocks) && blocks.length > 0) {
            (extraSoT as any).rephraseBlocks = blocks;
          }

          const head =
            (metaExtraB as any)?.rephraseHead ??
            (metaExtraB as any)?.rephrase?.head ??
            (metaExtraA as any)?.rephraseHead ??
            (metaExtraA as any)?.rephrase?.head ??
            (metaExtraC as any)?.rephraseHead ??
            (metaExtraC as any)?.rephrase?.head ??
            (metaExtraD as any)?.rephraseHead ??
            (metaExtraD as any)?.rephrase?.head ??
            null;

          if (!(extraSoT as any).rephraseHead && head) (extraSoT as any).rephraseHead = head;

          console.info('[IROS/pipe][META_EXTRA_MERGED]', {
            metaSource: (irosResult as any)?.metaForSave ? 'metaForSave' : ((irosResult as any)?.meta ? 'meta' : 'none'),
            metaExtraSources: {
              meta_extra: hasObj(metaExtraA),
              extraForHandle: hasObj(metaExtraB),
              result_extra: hasObj(metaExtraC),
              metaExtra: hasObj(metaExtraD),
            },
            mergedExtraHasBlocks: Array.isArray((extraSoT as any).rephraseBlocks),
            mergedExtraBlocksLen: (extraSoT as any).rephraseBlocks?.length ?? null,
            mergedHead: (extraSoT as any).rephraseHead ? String((extraSoT as any).rephraseHead).slice(0, 80) : null,
          });
        } else {
          console.info('[IROS/pipe][META_EXTRA_MERGED][NO_META_EXTRA]', {
            hasMeta: Boolean(metaAny),
            metaKeys: metaAny ? Object.keys(metaAny) : [],
          });
        }
      } catch (e) {
        console.warn('[IROS/pipe][META_EXTRA_MERGED][ERROR]', e);
      }

      // ✅ enable判定は SoT をソースにする（metaの欠落でOFFにならない）
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
        });

        meta = applied.meta;
        // ✅ SoT の参照を維持しつつ、返ってきた extra を SoT に差し替える
        extraSoT = applied.extraForHandle ?? extraSoT;


        // ✅ 保存側(metaForSave.extra)にも最小同期（null/空で潰さない）
        try {
          if (metaForSave && typeof metaForSave === 'object') {
            (metaForSave as any).extra = { ...((metaForSave as any).extra ?? {}) };

            const ex: any = extraSoT as any;
            const mergedBlocks2 = Array.isArray(ex?.rephraseBlocks) && ex.rephraseBlocks.length > 0 ? ex.rephraseBlocks : null;
            const mergedHead2 = String(ex?.rephraseHead ?? '').trim() || null;
            const mergedCtx2 = ex?.ctxPack && typeof ex.ctxPack === 'object' ? ex.ctxPack : null;

            if (mergedBlocks2 && !Array.isArray((metaForSave as any).extra?.rephraseBlocks)) {
              (metaForSave as any).extra.rephraseBlocks = mergedBlocks2;
            }
            if (mergedHead2 && !String((metaForSave as any).extra?.rephraseHead ?? '').trim()) {
              (metaForSave as any).extra.rephraseHead = mergedHead2;
            }
            if (mergedCtx2 && !(metaForSave as any).extra?.ctxPack) {
              (metaForSave as any).extra.ctxPack = mergedCtx2;
            }
          }

          // ✅ meta.extra 側も満たす（renderGateway が meta.extra 経由で見る経路）
          if (meta && typeof meta === 'object') {
            (meta as any).extra = { ...((meta as any).extra ?? {}) };
            const ex: any = extraSoT as any;

            if (!Array.isArray((meta as any).extra?.rephraseBlocks) && Array.isArray(ex?.rephraseBlocks) && ex.rephraseBlocks.length > 0) {
              (meta as any).extra.rephraseBlocks = ex.rephraseBlocks;
              (meta as any).extra.rephraseBlocksAttached = true;
            }
            if (!String((meta as any).extra?.rephraseHead ?? '').trim() && String(ex?.rephraseHead ?? '').trim()) {
              (meta as any).extra.rephraseHead = String(ex.rephraseHead).trim();
            }
            if (!(meta as any).extra?.ctxPack && ex?.ctxPack && typeof ex.ctxPack === 'object') {
              (meta as any).extra.ctxPack = ex.ctxPack;
            }
          }
        } catch (e) {
          console.warn('[IROS/pipe][APPLY_RENDER_ENGINE][SYNC_META_EXTRA][ERROR]', e);
        }
      }

      // sanitize header
      {
        const before = String((result as any)?.content ?? '');
        const sanitized = sanitizeFinalContent(before);
        (result as any).content = sanitized.text.trimEnd();
        meta.extra = { ...(meta.extra ?? {}), finalHeaderStripped: sanitized.removed.length ? sanitized.removed : null };
      }

      // FINAL本文の確定（ここでは “生成しない”／あくまで strip + recover（既存資材から）だけ）
      {
        const curRaw = String((result as any)?.content ?? '');
        const curTrim = curRaw.trim();

        const speechAct = String(meta?.extra?.speechAct ?? meta?.speechAct ?? '').toUpperCase();
        const silenceReason = pickSilenceReason(meta);

        const emptyLike = isEffectivelyEmptyText(curTrim);
        const userNonEmpty = String(userTextClean ?? '').trim().length > 0;

        // ✅ SILENCE は「空入力専用」を原則にする（誤SILENCEで無言化させない）
        const silentAllowed = !userNonEmpty;
        const isSilent = speechAct === 'SILENCE' && emptyLike && silentAllowed;

        // ✅ スロット指示が本文に漏れているか（@OBS/@SHIFT/...）
        const hasSlotDirectives = /(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b/.test(curRaw);

        // ✅ recover材料（SoTから）
        const ex: any = extraSoT as any;
        const head = String(ex?.rephraseHead ?? '').trim();
        const blocks: any[] = Array.isArray(ex?.rephraseBlocks) ? ex.rephraseBlocks : [];

        const blocksToText = (bs: any[]) => {
          const lines = bs
            .map((b) => String(b?.text ?? b?.content ?? b?.value ?? b?.body ?? '').trimEnd())
            .filter((s) => s.trim().length > 0);
          return lines.join('\n\n').trimEnd();
        };

        const recoveredFromBlocks = blocks.length > 0 ? blocksToText(blocks) : '';
        const recoveredText = head || recoveredFromBlocks;

        // ✅ 非SILENCEで (空っぽ or スロット漏れ) の場合、既存資材から復元できるなら置換
        const needRecover = !isSilent && (emptyLike || hasSlotDirectives);

        const stripSlotDirectives = (s: string) => {
          const raw = String(s ?? '');
          if (!raw) return raw;
          const out = raw
            .replace(/(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b[^\n]*\n?/g, '$1')
            .replace(/\n{3,}/g, '\n\n')
            .trimEnd();
          return out;
        };

        const curNoSlots = hasSlotDirectives ? stripSlotDirectives(curRaw) : curRaw.trimEnd();
        const curNoSlotsTrim = curNoSlots.trim();

        const finalText = isSilent
          ? ''
          : needRecover
            ? recoveredText
              ? recoveredText
              : curNoSlotsTrim.length > 0
                ? curNoSlots
                : curRaw.trimEnd()
            : curRaw.trimEnd();

        if (String(process.env.IROS_DEBUG_SILENCE_PIPE ?? '0').trim() === '1') {
          console.info('[IROS/pipe][FINAL_TEXT]', {
            conversationId,
            userCode,
            speechAct,
            silenceReason: silenceReason ?? null,
            userNonEmpty,
            silentAllowed,
            curRawLen: curRaw.length,
            curTrimLen: curTrim.length,
            emptyLike,
            hasSlotDirectives,
            sotHasBlocks: Array.isArray(ex?.rephraseBlocks),
            sotBlocksLen: Array.isArray(ex?.rephraseBlocks) ? ex.rephraseBlocks.length : null,
            sotHeadLen: head ? head.length : 0,
            recoveredFromBlocksLen: recoveredFromBlocks.length,
            finalTextLen: finalText.length,
            finalTextPolicyCandidate: isSilent
              ? silenceReason
                ? `SILENCE:${silenceReason}`
                : 'SILENCE_EMPTY_BODY'
              : needRecover
                ? recoveredText
                  ? 'RECOVERED_FROM_SOT'
                  : curNoSlotsTrim.length > 0
                    ? 'STRIPPED_SLOT_DIRECTIVES'
                    : 'NEED_RECOVER_BUT_FALLBACK_CURRAW'
                : 'NORMAL_BODY',
          });
        }

        (result as any).content = finalText;
        (result as any).text = finalText;
        (result as any).assistantText = finalText;
        assistantText = finalText;

        meta.extra = {
          ...(meta.extra ?? {}),
          finalAssistantTextSynced: true,
          finalAssistantTextLen: finalText.length,
          finalTextRecoveredFromSoT: needRecover && Boolean(recoveredText) ? true : undefined,
          finalTextRecoveredSource: needRecover && Boolean(recoveredText) ? (head ? 'rephraseHead' : 'rephraseBlocks') : undefined,
          finalTextHadSlotDirectives: hasSlotDirectives ? true : undefined,
          finalTextStrippedSlotDirectives: needRecover && !recoveredText && hasSlotDirectives && curNoSlotsTrim.length > 0 ? true : undefined,
          finalTextPolicy: isSilent ? 'SILENCE_EMPTY_BODY' : meta?.extra?.finalTextPolicy ?? (finalText.length > 0 ? 'NORMAL_BODY' : 'NORMAL_EMPTY_PASS'),
          emptyFinalPatched: finalText.length === 0 ? true : undefined,
          emptyFinalPatchedReason:
            finalText.length === 0
              ? isSilent
                ? silenceReason
                  ? `SILENCE:${silenceReason}`
                  : 'SILENCE_EMPTY_BODY'
                : needRecover
                  ? 'NEED_RECOVER_BUT_EMPTY'
                  : 'NON_SILENCE_EMPTY_CONTENT'
              : undefined,
        };
      }

      // UI MODE確定
      {
        const finalText = String((result as any)?.content ?? '').trim();
        const uiMode = inferUIMode({ modeHint: mode, effectiveMode, meta, finalText });
        const uiReason = inferUIModeReason({ modeHint: mode, effectiveMode, meta, finalText });

        meta.mode = uiMode;
        meta.modeReason = uiReason;
        meta.persistPolicy = PERSIST_POLICY;

        meta.extra = {
          ...(meta.extra ?? {}),
          uiMode,
          uiModeReason: uiReason,
          persistPolicy: PERSIST_POLICY,
          uiFinalTextLen: finalText.length,
        };
      }

      // assistant 保存（single-writer）
      try {
        // NOTE: ここは「保存の最終防衛線」。
        // finalAssistant が空のままだと EMPTY_CONTENT で persist が必ずスキップされ、UIが …… に落ちる。
        // まずは seed を “commit本文” に昇格させて止血する（配線追加なし）。

        let finalAssistant =
          String((result as any)?.content ?? '').trim() ||
          String((result as any)?.text ?? '').trim() ||
          String((result as any)?.assistantText ?? '').trim();

        const uiMode = (meta as any)?.mode as ReplyUIMode | undefined;
        const silenceReason = pickSilenceReason(meta);

        // seed 候補（postprocess / handle で仕込まれている想定）
        const seedForPersist =
          String(((meta as any)?.extra as any)?.llmRewriteSeed ?? '').trim() ||
          String(((meta as any)?.extra as any)?.slotPlanSeed ?? '').trim() ||
          '';

        // ✅ 非SILENCE なのに本文が空なら、seed を本文に昇格して EMPTY_CONTENT を潰す
        // （Q1_SUPPRESS の “沈黙止血” は uiMode === 'SILENCE' 側で守られる）
// ✅ 非SILENCE なのに本文が空なら、seed を本文に昇格して EMPTY_CONTENT を潰す
// ただし seed が「@OBS/@SHIFT など内部マーカーだけ」の場合は昇格しない（昇格→strip→空→…… の自爆を防ぐ）
const emptyBefore = finalAssistant.length === 0;

const stripInternalDirectiveLines = (raw: string): string => {
  const lines = String(raw ?? '')
    .split('\n')
    .map((l) => String(l ?? '').trim())
    .filter(Boolean);

  // @ で始まる行を除去
  const cleaned = lines.filter((l) => !l.startsWith('@')).join('\n').trim();
  return cleaned;
};

const seedCleanedForPersist = stripInternalDirectiveLines(seedForPersist);

// ✅ seed が directives のみなら「昇格しない」
// - directives だけを昇格すると、その後の strip で必ず空になり、normalBase の "……" に落ちる
const seedIsDirectiveOnly = seedForPersist.length > 0 && seedCleanedForPersist.length === 0;

if (uiMode !== 'SILENCE' && emptyBefore && seedForPersist && !seedIsDirectiveOnly) {
  finalAssistant = seedCleanedForPersist || seedForPersist;

  meta.extra = {
    ...(meta.extra ?? {}),
    persistRecoveredFromSeed: true,
    persistRecoveredSeedLen: seedForPersist.length,
    persistRecoveredSeedCleanedLen: seedCleanedForPersist.length,
    persistRecoveredSeedDirectiveOnly: false,
  };

  console.warn('[IROS/persist][RECOVER_FROM_SEED]', {
    conversationId,
    userCode,
    recoveredLen: finalAssistant.length,
    seedLen: seedForPersist.length,
    seedCleanedLen: seedCleanedForPersist.length,
    seedHead: seedForPersist.slice(0, 120),
  });
} else if (uiMode !== 'SILENCE' && emptyBefore && seedForPersist && seedIsDirectiveOnly) {
  // 昇格を抑止したことをログに残す（原因追跡用）
  meta.extra = {
    ...(meta.extra ?? {}),
    persistRecoverFromSeedSkipped: true,
    persistRecoverSkipReason: 'SEED_DIRECTIVE_ONLY',
    persistRecoverSeedLen: seedForPersist.length,
  };

  console.warn('[IROS/persist][RECOVER_FROM_SEED_SKIPPED]', {
    conversationId,
    userCode,
    reason: 'SEED_DIRECTIVE_ONLY',
    seedLen: seedForPersist.length,
    seedHead: seedForPersist.slice(0, 120),
  });
}


        const pickString = (v: any): string | null => {
          if (typeof v !== 'string') return null;
          const s = v.trim();
          return s ? s : null;
        };

        const qCodeFinal =
          pickString((meta as any)?.unified?.q?.code) ??
          pickString((meta as any)?.unified?.q?.current) ??
          pickString((meta as any)?.q_code) ??
          pickString((meta as any)?.qCode) ??
          null;

        const depthStageFinal =
          pickString((meta as any)?.unified?.depth?.stage) ??
          pickString((meta as any)?.depth_stage) ??
          pickString((meta as any)?.depthStage) ??
          pickString((meta as any)?.depth) ??
          null;

        (meta as any).q_code = qCodeFinal;
        (meta as any).depth_stage = depthStageFinal;
        if (qCodeFinal) (meta as any).qCode = qCodeFinal;
        if (depthStageFinal) (meta as any).depthStage = depthStageFinal;

        if (uiMode === 'SILENCE') {
          meta.extra = {
            ...(meta.extra ?? {}),
            persistedAssistantMessage: {
              ok: true,
              inserted: false,
              skipped: true,
              reason: 'UI_MODE_SILENCE_NO_INSERT',
              silenceReason: silenceReason ?? null,
            },
          };
        } else if (finalAssistant.length > 0) {
          const saved = await persistAssistantMessageToIrosMessages({
            supabase,
            conversationId,
            userCode,
            content: finalAssistant,
            meta: meta ?? null,
          });

          meta.extra = {
            ...(meta.extra ?? {}),
            persistedAssistantMessage: {
              ok: true,
              inserted: true,
              skipped: false,
              len: finalAssistant.length,
              saved,
            },
          };
        } else {
          meta.extra = {
            ...(meta.extra ?? {}),
            persistedAssistantMessage: { ok: true, inserted: false, skipped: true, reason: 'EMPTY_CONTENT' },
          };
        }
      } catch (e) {
        meta.extra = {
          ...(meta.extra ?? {}),
          persistedAssistantMessage: {
            ok: false,
            inserted: false,
            skipped: true,
            reason: 'EXCEPTION',
            error: String((e as any)?.message ?? e),
          },
        };
      }

      // training sample
      const skipTraining = meta?.skipTraining === true || meta?.skip_training === true || meta?.recallOnly === true || meta?.recall_only === true;

      if (!skipTraining) {
        const replyText =
          (typeof (result as any)?.text === 'string' && (result as any).text.trim()) ||
          (typeof (result as any)?.assistantText === 'string' && (result as any).assistantText.trim()) ||
          ((result as any).content ?? '');

        await saveIrosTrainingSample({
          supabase,
          userCode,
          tenantId,
          conversationId,
          messageId: null,
          inputText: userTextClean,
          replyText,
          meta,
          tags: ['iros', 'auto'],
        });
      } else {
        meta.extra = {
          ...(meta.extra ?? {}),
          trainingSkipped: true,
          trainingSkipReason: meta?.skipTraining === true || meta?.skip_training === true ? 'skipTraining' : 'recallOnly',
        };
      }

      // result 側の衝突キー除去
      const resultObj = { ...(result as any) };
      delete (resultObj as any).mode;
      delete (resultObj as any).meta;
      delete (resultObj as any).ok;
      delete (resultObj as any).credit;

      return NextResponse.json({ ...resultObj, ...basePayload, mode: effectiveMode, meta }, { status: 200, headers });
    }

    // =========================================================
    // result が string等
    // =========================================================
    {
      const metaString: any = {
        userProfile: userProfile ?? null,
        extra: {
          userCode,
          hintText,
          traceId,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          persistedByRoute: true,
          persistAssistantMessage: false,
          renderEngineGate: extraSoT?.renderEngineGate === true,
          renderEngine: extraSoT?.renderEngine === true,
        },
      };

      const finalText = String(result ?? '').trim();
      const uiMode = inferUIMode({ modeHint: mode, effectiveMode, meta: metaString, finalText });
      const uiReason = inferUIModeReason({ modeHint: mode, effectiveMode, meta: metaString, finalText });

      metaString.mode = uiMode;
      metaString.modeReason = uiReason;
      metaString.persistPolicy = PERSIST_POLICY;
      metaString.extra = {
        ...(metaString.extra ?? {}),
        uiMode,
        uiModeReason: uiReason,
        persistPolicy: PERSIST_POLICY,
      };

      return NextResponse.json({ ...basePayload, content: finalText, meta: metaString }, { status: 200, headers });
    }
  } catch (err: any) {
    const headers: Record<string, string> = { ...CORS_HEADERS };
    headers['x-trace-id'] = String(traceIdEarly);
    return NextResponse.json(
      { ok: false, error: 'internal_error', detail: String(err?.message ?? err) },
      { status: 500, headers },
    );
  }
}

// =========================================================
// ✅ RenderEngine 適用（single entry）
// - enableRenderEngine=true の場合は render-v2 (renderGatewayAsReply)
// - IT の場合のみ renderReply（従来）を維持
// - 返り値は必ず { meta, extraForHandle } に統一
// - rephraseBlocks の生成（fallback）は “ここだけ” で行う
// =========================================================
async function applyRenderEngineIfEnabled(params: {
  enableRenderEngine: boolean;
  isIT: boolean;
  meta: any;
  extraForHandle: any;
  resultObj: any;
  conversationId: string; // ✅ null にしない
  userCode: string;       // ✅ null にしない
  userText: string;       // ✅ null にしない
}): Promise<{ meta: any; extraForHandle: any }> {

  const { enableRenderEngine, isIT, meta, extraForHandle, resultObj, conversationId, userCode, userText } = params;

  // =========================
  // IT は従来render（renderReply）
  // =========================
  if (isIT) {
    try {
      const contentBefore = String(resultObj?.content ?? '').trim();

      const fallbackFacts =
        contentBefore.length > 0
          ? contentBefore
          : String(
              (meta as any)?.situationSummary ??
                (meta as any)?.situation_summary ??
                meta?.unified?.situation?.summary ??
                '',
            ).trim() ||
            String(userText ?? '').trim() ||
            '';

      const vector = buildResonanceVector({
        qCode: (meta as any)?.qCode ?? (meta as any)?.q_code ?? meta?.unified?.q?.current ?? null,
        depth: (meta as any)?.depth ?? (meta as any)?.depth_stage ?? meta?.unified?.depth?.stage ?? null,
        phase: (meta as any)?.phase ?? meta?.unified?.phase ?? null,
        selfAcceptance:
          (meta as any)?.selfAcceptance ??
          (meta as any)?.self_acceptance ??
          meta?.unified?.selfAcceptance ??
          meta?.unified?.self_acceptance ??
          null,
        yLevel: (meta as any)?.yLevel ?? (meta as any)?.y_level ?? meta?.unified?.yLevel ?? meta?.unified?.y_level ?? null,
        hLevel: (meta as any)?.hLevel ?? (meta as any)?.h_level ?? meta?.unified?.hLevel ?? meta?.unified?.h_level ?? null,
        polarityScore:
          (meta as any)?.polarityScore ??
          (meta as any)?.polarity_score ??
          meta?.unified?.polarityScore ??
          meta?.unified?.polarity_score ??
          null,
        polarityBand:
          (meta as any)?.polarityBand ??
          (meta as any)?.polarity_band ??
          meta?.unified?.polarityBand ??
          meta?.unified?.polarity_band ??
          null,
        stabilityBand:
          (meta as any)?.stabilityBand ??
          (meta as any)?.stability_band ??
          meta?.unified?.stabilityBand ??
          meta?.unified?.stability_band ??
          null,
        situationSummary:
          (meta as any)?.situationSummary ?? (meta as any)?.situation_summary ?? meta?.unified?.situation?.summary ?? null,
        situationTopic:
          (meta as any)?.situationTopic ?? (meta as any)?.situation_topic ?? meta?.unified?.situation?.topic ?? null,
        intentLayer:
          (meta as any)?.intentLayer ??
          (meta as any)?.intent_layer ??
          (meta as any)?.intentLine?.focusLayer ??
          (meta as any)?.intent_line?.focusLayer ??
          meta?.unified?.intentLayer ??
          null,
        intentConfidence:
          (meta as any)?.intentConfidence ??
          (meta as any)?.intent_confidence ??
          (meta as any)?.intentLine?.confidence ??
          (meta as any)?.intent_line?.confidence ??
          null,
      });

      const baseInput = {
        facts: fallbackFacts,
        insight: null,
        nextStep: null,
        userWantsEssence: false,
        highDefensiveness: false,
        seed: String(conversationId ?? ''),
        userText: String(userText ?? ''),
      } as const;

      const baseOpts = {
        minimalEmoji: false,
        renderMode: 'IT',
        itDensity:
          (meta as any)?.itDensity ??
          (meta as any)?.density ??
          (meta as any)?.extra?.itDensity ??
          (meta as any)?.extra?.density ??
          undefined,
      } as any;

      const patched = applyRulebookCompat({
        vector,
        input: baseInput,
        opts: baseOpts,
        meta,
        extraForHandle,
      });

      const rendered = renderReply((patched.vector ?? vector) as any, (patched.input ?? baseInput) as any, (patched.opts ?? baseOpts) as any);

      const renderedText =
        typeof rendered === 'string'
          ? rendered
          : (rendered as any)?.text
            ? String((rendered as any).text)
            : String(rendered ?? '');

      const sanitized = sanitizeFinalContent(renderedText);

      const speechActUpper = String((patched.meta as any)?.extra?.speechAct ?? (patched.meta as any)?.speechAct ?? '').toUpperCase();
      const isSilence = speechActUpper === 'SILENCE';

      const nextContent = isSilence
        ? sanitized.text.trimEnd()
        : sanitized.text.trim().length > 0
          ? sanitized.text.trimEnd()
          : contentBefore.length > 0
            ? contentBefore
            : String(fallbackFacts ?? '').trim();

      resultObj.content = nextContent;
      (resultObj as any).assistantText = nextContent;
      (resultObj as any).text = nextContent;

      const metaAfter = (patched.meta ?? meta) as any;
      metaAfter.extra = {
        ...(metaAfter.extra ?? {}),
        renderEngineApplied: true,
        renderEngineKind: 'IT',
        headerStripped: sanitized.removed.length ? sanitized.removed : null,
      };

      return { meta: metaAfter, extraForHandle: (patched.extraForHandle ?? extraForHandle) as any };
    } catch (e) {
      meta.extra = {
        ...(meta?.extra ?? {}),
        renderEngineApplied: false,
        renderEngineKind: 'IT',
        renderEngineError: String((e as any)?.message ?? e),
      };
      return { meta, extraForHandle };
    }
  }

  // render無効なら何もしない
  if (!enableRenderEngine) {
    meta.extra = { ...(meta?.extra ?? {}), renderEngineApplied: false, renderEngineKind: 'OFF' };
    return { meta, extraForHandle };
  }

  // =========================
  // render-v2（renderGatewayAsReply）
  // =========================
  try {
    // ✅ render入力は “読み取り専用合成” にし、SoT(extraForHandle)を書き換えない
    const extraForRender: any = {
      ...(meta?.extra ?? {}),
      ...(extraForHandle ?? {}),
      slotPlanPolicy:
        (meta as any)?.framePlan?.slotPlanPolicy ??
        (meta as any)?.slotPlanPolicy ??
        (meta as any)?.extra?.slotPlanPolicy ??
        null,
      framePlan: (meta as any)?.framePlan ?? null,
      slotPlan: (meta as any)?.slotPlan ?? null,

      // evidence最小
      conversationId,
      userCode,
      userText: typeof userText === 'string' ? userText : null,
    };

    const maxLines =
      Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)) && Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8;

    const baseText = String((resultObj as any)?.assistantText ?? (resultObj as any)?.content ?? (resultObj as any)?.text ?? '').trimEnd();

    // ✅ SoT（この関数が返す extraForHandle）：
    // - ここでは “必要なら埋める” が、なるべく最小にする
    const extraSoT: any = extraForHandle ?? {};

// ===================== (2) 置き換え：route.ts 1290〜1328 =====================
// ↓↓↓ いまある “✅ rephraseBlocks の fallback 生成は ここだけ” ブロック全体を
//（1290〜1328）丸ごと削除して、代わりにこのブロックを貼ってください ↓↓↓

    // ✅ rephraseBlocks の生成/付与は _impl/rephrase.ts に一本化
    // - extraSoT（SoT）と meta.extra をそこで更新する
    // - ここでは “fallback生成” をしない
    await maybeAttachRephraseForRenderV2({
      conversationId,
      userCode,
      userText: typeof userText === 'string' ? userText : String(userText ?? ''),
      meta,
      extraMerged: extraSoT,
      // 任意（無くても動く）
      traceId: (meta as any)?.traceId ?? null,
      effectiveMode:
        (extraSoT as any)?.effectiveMode ??
        (meta as any)?.extra?.effectiveMode ??
        null,
    });

// ↑↑↑ ここまでを 1290〜1328 の代わりに貼る ↑↑↑

    // ✅ SoTの blocks/head を render input に同期（render input は読み取り専用）
    if (Array.isArray(extraSoT?.rephraseBlocks) && extraSoT.rephraseBlocks.length > 0 && !Array.isArray(extraForRender?.rephraseBlocks)) {
      extraForRender.rephraseBlocks = extraSoT.rephraseBlocks;
    }
    {
      const mergedHead = String(extraSoT?.rephraseHead ?? '').trim();
      if (mergedHead && !String(extraForRender?.rephraseHead ?? '').trim()) extraForRender.rephraseHead = mergedHead;
    }

    // ✅ IRの基準本文（短文化ガード用）を renderGateway に渡す
    {
      const mergedFinal = String(extraSoT?.finalAssistantText ?? '').trim() || String(extraSoT?.finalAssistantTextCandidate ?? '').trim() || '';
      if (mergedFinal && !String(extraForRender?.finalAssistantText ?? '').trim()) {
        extraForRender.finalAssistantText = mergedFinal;
      }

      const mergedResolved = String(extraSoT?.resolvedText ?? '').trim();
      if (mergedResolved && !String(extraForRender?.resolvedText ?? '').trim()) {
        extraForRender.resolvedText = mergedResolved;
      }
    }

    const keysToCarry = ['rephraseBlocksAttached', 'rephraseAttachSkipped', 'rephraseLLMApplied', 'rephraseApplied', 'rephraseReason'] as const;
    for (const k of keysToCarry) {
      if ((extraForRender as any)[k] == null && (extraSoT as any)?.[k] != null) (extraForRender as any)[k] = (extraSoT as any)[k];
    }

    console.info('[DEBUG/RENDERGW_CALL]', {
      baseTextLen: typeof baseText === 'string' ? baseText.length : null,
      baseTextHead: typeof baseText === 'string' ? baseText.slice(0, 80) : null,
      renderEngine: (extraForRender as any)?.renderEngine ?? null,
      hasRephraseBlocks: Array.isArray((extraForRender as any)?.rephraseBlocks),
      rephraseBlocksLen: Array.isArray((extraForRender as any)?.rephraseBlocks) ? (extraForRender as any).rephraseBlocks.length : null,
      rephraseBlocksHead:
        Array.isArray((extraForRender as any)?.rephraseBlocks) && (extraForRender as any).rephraseBlocks[0]
          ? String((extraForRender as any).rephraseBlocks[0]?.text ?? '').slice(0, 120)
          : null,
      hasRephraseObj: !!(extraForRender as any)?.rephrase,
      rephraseObjKeys: (extraForRender as any)?.rephrase ? Object.keys((extraForRender as any).rephrase) : null,
    });

    const out = renderGatewayAsReply({ text: baseText, extra: extraForRender, maxLines }) as any;

    console.info('[DEBUG/RENDERGW_OUT]', {
      outType: typeof out,
      outKeys: out && typeof out === 'object' ? Object.keys(out) : null,
      contentType: typeof out?.content,
      contentLen: typeof out?.content === 'string' ? out.content.length : null,
      contentHead: typeof out?.content === 'string' ? out.content.slice(0, 120) : null,
      meta: out?.meta ?? null,
    });

    const outText = String((typeof out === 'string' ? out : out?.text ?? out?.content ?? out?.assistantText ?? baseText) ?? '').trimEnd();
    const sanitized = sanitizeFinalContent(outText);

    resultObj.content = sanitized.text.trimEnd();
    (resultObj as any).assistantText = sanitized.text.trimEnd();
    (resultObj as any).text = sanitized.text.trimEnd();

    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: true,
      renderEngineKind: 'V2',
      headerStripped: sanitized.removed.length ? sanitized.removed : null,
      renderV2PickedFrom: out?.pickedFrom ?? null,
      renderV2OutLen: sanitized.text.length,
    };

    // ✅ SoTを返す（render input は返さない）
    return { meta, extraForHandle: extraSoT };
  } catch (e) {
    console.error('[IROS/render-v2][EXCEPTION]', e);
    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: false,
      renderEngineKind: 'V2',
      renderEngineError: String((e as any)?.message ?? e),
    };
    return { meta, extraForHandle };
  }
}
