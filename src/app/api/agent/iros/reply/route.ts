// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { authorizeChat, captureChat, makeIrosRef } from '@/lib/credits/auto';

import { loadIrosUserProfile } from '@/lib/iros/server/loadUserProfile';
import { saveIrosTrainingSample } from '@/lib/iros/server/saveTrainingSample';
import {
  handleIrosReply,
  type HandleIrosReplyOutput,
} from '@/lib/iros/server/handleIrosReply';

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';
import { resolveModeHintFromText, resolveRememberScope } from './_mode';

import {
  attachNextStepMeta,
  extractNextStepChoiceFromText,
  findNextStepOptionById,
} from '@/lib/iros/nextStepOptions';

import { buildResonanceVector } from '@lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { loadIrosMemoryState } from '@/lib/iros/memoryState';

import {
  pickUserCode,
  pickUid,
  pickSpeechAct,
  pickSilenceReason,
  isEffectivelyEmptyText,
  inferUIMode,
  inferUIModeReason,
  sanitizeFinalContent,
  normalizeMetaLevels,
} from './_helpers';
import type { ReplyUIMode } from './_helpers';

import {
  extractSlotsForRephrase,
  rephraseSlotsFinal,
} from '@/lib/iros/language/rephraseEngine';

// =========================================================
// CORS
// =========================================================
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'Content-Type, Authorization, x-user-code, x-credit-cost',
} as const;

// 既定：1往復 = 5pt（ENVで上書き可）
const CHAT_CREDIT_AMOUNT = Number(process.env.IROS_CHAT_CREDIT_AMOUNT ?? 5);

// 残高しきい値（ENVで上書き可）
const LOW_BALANCE_THRESHOLD = Number(
  process.env.IROS_LOW_BALANCE_THRESHOLD ?? 10,
);

const PERSIST_POLICY = 'REPLY_SINGLE_WRITER' as const;

// service-role supabase（残高チェック + 訓練用保存 + assistant保存）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// =========================================================
// small utils
// =========================================================
function pickText(...vals: any[]): string {
  for (const v of vals) {
    const s = typeof v === 'string' ? v : String(v ?? '');
    const t = s.replace(/\r\n/g, '\n').trimEnd();
    if (t.length > 0) return t;
  }
  return '';
}

function normalizeHistoryMessages(
  raw: unknown[] | string | null | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (!raw) return [];
  if (typeof raw === 'string') return [];

  if (!Array.isArray(raw)) return [];

  const out: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of raw.slice(-24)) {
    if (!m || typeof m !== 'object') continue;

    const roleRaw = String((m as any)?.role ?? (m as any)?.speaker ?? (m as any)?.type ?? '')
      .toLowerCase()
      .trim();

    const body = String(
      (m as any)?.content ?? (m as any)?.text ?? (m as any)?.message ?? '',
    )
      .replace(/\r\n/g, '\n')
      .trim();

    if (!body) continue;

    const isAssistant =
      roleRaw === 'assistant' ||
      roleRaw === 'bot' ||
      roleRaw === 'system' ||
      roleRaw.startsWith('a');

      out.push({
      role: (isAssistant ? 'assistant' : 'user') as 'assistant' | 'user',
        content: body,
      });

  }
  return out.slice(-12);
}

// =========================================================
// rephrase attach (render-v2向け / 1回だけ)
// =========================================================
async function maybeAttachRephraseForRenderV2(args: {
  conversationId: string;
  userCode: string;
  userText: string;
  meta: any;
  extraMerged: Record<string, any>;
  historyMessages?: unknown[] | string | null;
  memoryStateForCtx?: any | null;
  traceId?: string | null;

  // ✅ 追加：routeで確定した最終mode（UI modeより先に使える）
  effectiveMode?: string | null;
}) {
  const {
    conversationId,
    userCode,
    userText,
    meta,
    extraMerged,
    historyMessages,
    memoryStateForCtx,
    traceId,
    effectiveMode,
  } = args;

  // ---- helpers (no-throw) ----
  const setSkip = (reason: string, detail?: Record<string, any>) => {
    try {
      const payload = { reason, ...(detail ?? {}) };

      // ✅ “黙って止まる” をゼロにする：必ず meta.extra に残す
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseApplied: false,
        rephraseAttachSkipped: true,
        rephraseAttachReason: reason,
        rephraseAttachDetail: payload,
      };

      // ✅ renderGateway 側でも拾えるように extraMerged にも残す（露出禁止前提の内部meta）
      (extraMerged as any).rephraseAttachSkipped = true;
      (extraMerged as any).rephraseAttachReason = reason;

      // ✅ ログ1行（本文/JWTは出さない）
      console.log('[IROS/rephraseAttach][SKIP]', {
        conversationId,
        userCode,
        reason,
        effectiveMode: effectiveMode ?? null,
        hintedRenderMode:
          (typeof meta?.renderMode === 'string' && meta.renderMode) ||
          (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
          (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
          null,
        speechAct: String(pickSpeechAct(meta) ?? '').toUpperCase() || null,
      });
    } catch {
      // no-op
    }
  };


  const upper = (v: any) => String(v ?? '').trim().toUpperCase();

  // ---- 1) gate ----
  const enabled =
    String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    setSkip('DISABLED_BY_ENV', { env: 'IROS_REPHRASE_FINAL_ENABLED' });
    return;
  }

  // render-v2 only
  if (extraMerged?.renderEngine !== true) {
    setSkip('RENDER_ENGINE_OFF', { renderEngine: extraMerged?.renderEngine });
    return;
  }

  // ITでも attach を許可するスイッチ（デフォは止める＝現状維持）
  const allowIT =
    String(process.env.IROS_REPHRASE_ALLOW_IT ?? '0').trim() === '1';

  // ✅ UI mode確定より前でも、route最終modeがITなら通常は止める（ただし allowIT=1 なら通す）
  if (!allowIT && upper(effectiveMode) === 'IT') {
    setSkip('SKIP_BY_EFFECTIVE_MODE_IT', { effectiveMode });
    return;
  }

  const hintedRenderMode =
    (typeof meta?.renderMode === 'string' && meta.renderMode) ||
    (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
    (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
    '';

  if (!allowIT && upper(hintedRenderMode) === 'IT') {
    setSkip('SKIP_BY_HINTED_RENDER_MODE_IT', { hintedRenderMode });
    return;
  }

  const speechAct = upper(pickSpeechAct(meta));
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') {
    setSkip('SKIP_BY_SPEECH_ACT', { speechAct });
    return;
  }

  // ---- 2) idempotent ----
  if (
    Array.isArray((extraMerged as any)?.rephraseBlocks) &&
    (extraMerged as any).rephraseBlocks.length > 0
  ) {
    setSkip('ALREADY_HAS_REPHRASE_BLOCKS', {
      blocksLen: (extraMerged as any)?.rephraseBlocks?.length ?? 0,
    });
    return;
  }

  // ---- 3) slots ----
  const extraForRender = {
    ...(meta?.extra ?? {}),
    ...(extraMerged ?? {}),
    slotPlanPolicy:
      (meta as any)?.framePlan?.slotPlanPolicy ??
      (meta as any)?.slotPlanPolicy ??
      (meta as any)?.extra?.slotPlanPolicy ??
      null,
    framePlan: (meta as any)?.framePlan ?? null,
    slotPlan: (meta as any)?.slotPlan ?? null,
  };

  const extracted = extractSlotsForRephrase(extraForRender);
  if (!extracted?.slots?.length) {
    setSkip('NO_SLOTS_FOR_REPHRASE');
    return;
  }

  // ---- 4) minimal userContext（直近履歴 + last_state） ----
  const normalizedHistory = normalizeHistoryMessages(historyMessages ?? null);

  const userContext = {
    conversation_id: String(conversationId),
    last_state: memoryStateForCtx ?? null,
    historyMessages: normalizedHistory.length ? normalizedHistory : undefined,
  };

  // ---- 5) call LLM ----
  try {
    const model =
      process.env.IROS_REPHRASE_MODEL ?? process.env.IROS_MODEL ?? 'gpt-4.1';

    // ✅ q/depth を “確定済みmeta” から拾う（LLM_CALLログ/内部packに載せる）
    const qCodeForLLM =
      (typeof (meta as any)?.q_code === 'string' && String((meta as any).q_code).trim()) ||
      (typeof (meta as any)?.qCode === 'string' && String((meta as any).qCode).trim()) ||
      (typeof (meta as any)?.qPrimary === 'string' && String((meta as any).qPrimary).trim()) ||
      (typeof (meta as any)?.unified?.q?.current === 'string' && String((meta as any).unified.q.current).trim()) ||
      null;

    const depthForLLM =
      (typeof (meta as any)?.depth_stage === 'string' && String((meta as any).depth_stage).trim()) ||
      (typeof (meta as any)?.depthStage === 'string' && String((meta as any).depthStage).trim()) ||
      (typeof (meta as any)?.depth === 'string' && String((meta as any).depth).trim()) ||
      (typeof (meta as any)?.unified?.depth?.stage === 'string' && String((meta as any).unified.depth.stage).trim()) ||
      null;

    const res = await rephraseSlotsFinal(extracted, {
      model,
      temperature: 0.2,
      maxLinesHint: Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES))
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8,
      userText: userText ?? null,
      userContext,
      debug: {
        traceId: traceId ?? null,
        conversationId,
        userCode,
        renderEngine: true,
        mode: effectiveMode ?? null, // route最終決定
        qCode: qCodeForLLM,
        depthStage: depthForLLM,
      },
    });

    if (!res.ok) {
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseApplied: false,
        rephraseAttachSkipped: false,
        rephraseReason: res.reason ?? 'unknown',
      };
      // ✅ renderGateway が見ている extra 側にも残す
      (extraMerged as any).rephraseApplied = false;
      (extraMerged as any).rephraseAttachSkipped = false;
      (extraMerged as any).rephraseReason = res.reason ?? 'unknown';
      return;
    }

    // =========================================================
    // ✅ splitToLines を統合して rephraseBlocks を確実に作る
    // =========================================================
    function splitToLines(text: string): string[] {
      const t = String(text ?? '').replace(/\r\n/g, '\n');
      if (!t) return [];

      const rawLines = t.split('\n').map((x) => x.replace(/\s+$/g, ''));

      if (rawLines.length === 1) {
        const one = rawLines[0] ?? '';
        const oneTrim = one.trim();

        const hasDecoration =
          one.includes('**') ||
          one.includes('__') ||
          one.includes('```') ||
          one.includes('[[') ||
          one.includes(']]') ||
          /[🌀🌱🪷🪔🌸✨🔥💧🌊🌌⭐️⚡️✅❌]/.test(one);

        if (!hasDecoration) {
          const parts0 = oneTrim
            .split(/(?<=[。！？!?])/)
            .map((x) => x.trim())
            .filter(Boolean);

          const parts: string[] = [];
          for (const p of parts0) {
            if (parts.length > 0 && /^[（(［\[]/.test(p)) {
              parts[parts.length - 1] = `${parts[parts.length - 1]}${p}`;
            } else {
              parts.push(p);
            }
          }

          if (parts.length >= 2) return parts;

          if (oneTrim.length >= 26 && oneTrim.includes('、')) {
            const i = oneTrim.indexOf('、');
            const a = oneTrim.slice(0, i + 1).trim();
            const b = oneTrim.slice(i + 1).trim();
            return [a, b].filter(Boolean);
          }

          if (oneTrim.length >= 34) {
            const mid = Math.min(22, Math.floor(oneTrim.length / 2));
            const a = oneTrim.slice(0, mid).trim();
            const b = oneTrim.slice(mid).trim();
            return [a, b].filter(Boolean);
          }
        }

        return [one];
      }

      return rawLines;
    }

    const textOut = String((res as any)?.text ?? (res as any)?.content ?? '').trimEnd();
    const fromBlocks = Array.isArray((res as any)?.blocks) ? (res as any).blocks : null;
    const fromSlots = Array.isArray((res as any)?.slots) ? (res as any).slots : null;

    const normalizedBlocks: Array<{ text: string; lines: string[] }> =
      (fromBlocks && fromBlocks.length > 0
        ? fromBlocks.map((b: any) => {
            const t = String(b?.text ?? b?.content ?? b ?? '').trimEnd();
            return { text: t, lines: splitToLines(t) };
          })
        : fromSlots && fromSlots.length > 0
          ? fromSlots.map((s: any) => {
              const t = String(s?.text ?? s?.content ?? s?.value ?? '').trimEnd();
              return { text: t, lines: splitToLines(t) };
            })
          : textOut.length > 0
            ? [{ text: textOut, lines: splitToLines(textOut) }]
            : []);

    // ✅ renderGateway が見ている extra（= extraMerged）に “必ず” attach
    (extraMerged as any).rephraseHead = textOut || null;
    (extraMerged as any).rephraseText = textOut || null;
    (extraMerged as any).rephraseBlocks = normalizedBlocks;
    (extraMerged as any).rephraseApplied = true;
    (extraMerged as any).rephraseAttachSkipped = false;
    (extraMerged as any).rephraseReason = null;

    // ✅ meta.extra にも残す（監査/デバッグ用）
    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseApplied: true,
      rephraseAttachSkipped: false,
      rephraseReason: null,
      rephraseHead: textOut || null,
      rephraseText: textOut || null,
      rephraseBlocks: normalizedBlocks,
    };


    (extraMerged as any).rephraseBlocks = (res as any).slots.map((s: any) => ({
      text: s.text,
    }));

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseApplied: true,
      rephraseAttachSkipped: false,
      rephraseModel: model,
      rephraseKeys: (res as any).meta?.outKeys ?? null,
      rephraseRawLen: (res as any).meta?.rawLen ?? null,
      rephraseRawHead: (res as any).meta?.rawHead ?? null,
      rephraseQ: qCodeForLLM,
      rephraseDepth: depthForLLM,
    };
  } catch (e) {
    // 例外でも route を落とさない
    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseApplied: false,
      rephraseAttachSkipped: false,
      rephraseReason: 'EXCEPTION',
      rephraseError: String((e as any)?.message ?? e),
    };
  }
}


// =========================================================
// OPTIONS
// =========================================================
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// =========================================================
// POST
// =========================================================
// ✅ 置き換え1：POST冒頭の reqId を削除（未使用）
export async function POST(req: NextRequest) {
  const startedAt = Date.now();

  try {
    // 1) auth
    const DEV_BYPASS = process.env.IROS_DEV_BYPASS_AUTH === '1';
    const hUserCode = req.headers.get('x-user-code');
    const bypassUserCode =
      hUserCode && hUserCode.trim().length > 0 ? hUserCode.trim() : null;

    let auth: any = null;
    if (DEV_BYPASS && bypassUserCode) {
      auth = { ok: true, userCode: bypassUserCode, uid: 'dev-bypass' };
    } else {
      auth = await verifyFirebaseAndAuthorize(req);
      if (!auth?.ok) {
        return NextResponse.json(
          { ok: false, error: 'unauthorized' },
          { status: 401, headers: CORS_HEADERS },
        );
      }
    }

    // 2) body
    const body = await req.json().catch(() => ({} as any));
    const conversationId: string | undefined = body?.conversationId;
    const text: string | undefined = body?.text;
    const hintText: string | undefined = body?.hintText ?? body?.modeHintText;
    const modeHintInput: string | undefined = body?.modeHint;
    const extra: Record<string, any> | undefined = body?.extra;

    const chatHistory: unknown[] | undefined = Array.isArray(body?.history)
      ? (body.history as unknown[])
      : undefined;

    const styleInput: string | undefined =
      typeof body?.style === 'string'
        ? body.style
        : typeof body?.styleHint === 'string'
          ? body.styleHint
          : undefined;

    // ...（この下はあなたのまま）


    if (!conversationId || !text) {
      return NextResponse.json(
        {
          ok: false,
          error: 'bad_request',
          detail: 'conversationId and text are required',
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    const tenantId: string =
      typeof body?.tenant_id === 'string' && body.tenant_id.trim().length > 0
        ? body.tenant_id.trim()
        : typeof body?.tenantId === 'string' && body.tenantId.trim().length > 0
          ? body.tenantId.trim()
          : 'default';

    // 3) mode
    const mode = resolveModeHintFromText({
      modeHint: modeHintInput,
      hintText,
      text,
    });

    const rememberScope: RememberScopeKind | null = resolveRememberScope({
      modeHint: modeHintInput,
      hintText,
      text,
    });

    // 4) ids
    const userCode = pickUserCode(req, auth);
    const traceId = extra?.traceId ?? extra?.trace_id ?? null;

    if (!userCode) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized_user_code_missing' },
        { status: 401, headers: CORS_HEADERS },
      );
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

    const CREDIT_AMOUNT =
      Number.isFinite(parsed) && parsed > 0 ? Number(parsed) : CHAT_CREDIT_AMOUNT;

    const creditRef = makeIrosRef(conversationId, startedAt);

    // 6) authorize
    const authRes = await authorizeChat(
      req,
      userCode,
      CREDIT_AMOUNT,
      creditRef,
      conversationId,
    );

    if (!authRes.ok) {
      const errCode = (authRes as any).error ?? 'credit_authorize_failed';
      const res = NextResponse.json(
        {
          ok: false,
          error: errCode,
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
        { status: 402, headers: CORS_HEADERS },
      );
      res.headers.set('x-reason', String(errCode));
      res.headers.set('x-user-code', userCode);
      res.headers.set('x-credit-ref', creditRef);
      res.headers.set('x-credit-amount', String(CREDIT_AMOUNT));
      if (traceId) res.headers.set('x-trace-id', String(traceId));
      return res;
    }

    // 7) low balance warn
    let lowWarn:
      | null
      | { code: 'low_balance'; balance: number; threshold: number } = null;

    if (Number.isFinite(LOW_BALANCE_THRESHOLD) && LOW_BALANCE_THRESHOLD > 0) {
      const { data: balRow, error: balErr } = await supabase
        .from('users')
        .select('sofia_credit')
        .eq('user_code', userCode)
        .maybeSingle();

      if (!balErr && balRow && balRow.sofia_credit != null) {
        const balance = Number(balRow.sofia_credit) || 0;
        if (balance < LOW_BALANCE_THRESHOLD) {
          lowWarn = {
            code: 'low_balance',
            balance,
            threshold: LOW_BALANCE_THRESHOLD,
          };
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
      extra && typeof (extra as any).choiceId === 'string'
        ? String((extra as any).choiceId).trim()
        : null;

    const extractedChoiceId =
      extracted?.choiceId && String(extracted.choiceId).trim().length > 0
        ? String(extracted.choiceId).trim()
        : null;

    const effectiveChoiceId = choiceIdFromExtra || extractedChoiceId || null;

    const cleanText =
      extracted?.cleanText && String(extracted.cleanText).trim().length > 0
        ? String(extracted.cleanText).trim()
        : '';

    const userTextClean = cleanText.length ? cleanText : rawText;

    // option（将来用）
    if (effectiveChoiceId) {
      findNextStepOptionById(effectiveChoiceId);
    }

    // 10) extra sanitize（route.tsでIT強制は扱わない）
    const rawExtra: Record<string, any> = (extra ?? {}) as any;
    const sanitizedExtra: Record<string, any> = { ...rawExtra };

    delete (sanitizedExtra as any).forceIT;
    delete (sanitizedExtra as any).renderMode;
    delete (sanitizedExtra as any).spinLoop;
    delete (sanitizedExtra as any).descentGate;
    delete (sanitizedExtra as any).tLayerModeActive;
    delete (sanitizedExtra as any).tLayerHint;

    let extraMerged: Record<string, any> = {
      ...sanitizedExtra,
      choiceId: effectiveChoiceId,
      extractedChoiceId,
    };

    const reqOrigin =
      req.headers.get('origin') ??
      req.headers.get('x-forwarded-origin') ??
      req.nextUrl?.origin ??
      '';

    // =========================================================
    // ✅ RenderEngine gate（PREで1回だけ確定し、同期して書く）
    // =========================================================
    {
      const envAllows = process.env.IROS_ENABLE_RENDER_ENGINE === '1';
      const enableRenderEngine =
        envAllows &&
        extraMerged.renderEngine !== false &&
        extraMerged.renderEngineGate !== false;

      extraMerged = {
        ...extraMerged,
        renderEngineGate: enableRenderEngine,
        renderEngine: enableRenderEngine,
      };
    }

    // =========================================================
    // ✅ persist gate（single-writer）
    // =========================================================
    {
      extraMerged = {
        ...extraMerged,
        persistedByRoute: true,
        persistAssistantMessage: false,
      };
    }

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

      extra: extraMerged,
    });

    // 11.5) NORMAL BASE fallback（非SILENCE/FORWARDで本文が空に近い場合）
    if (irosResult.ok) {
      const r: any = irosResult as any;
      const metaAny = r?.metaForSave ?? r?.meta ?? {};
      const extraAny = metaAny?.extra ?? {};
      const speechAct = String(extraAny?.speechAct ?? metaAny?.speechAct ?? '').toUpperCase();
      const allowLLM = extraAny?.speechAllowLLM ?? metaAny?.speechAllowLLM ?? true;

      const candidateText = pickText(r?.assistantText, r?.content);
      const isSilenceOrForward = speechAct === 'SILENCE' || speechAct === 'FORWARD';
      const isEmptyLike = isEffectivelyEmptyText(candidateText);

      const isNonSilenceButEmpty =
        !isSilenceOrForward &&
        allowLLM !== false &&
        String(userTextClean ?? '').trim().length > 0 &&
        isEmptyLike;

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
      }
    }

    if (!irosResult.ok) {
      const headers: Record<string, string> = {
        ...CORS_HEADERS,
        'x-credit-ref': creditRef,
        'x-credit-amount': String(CREDIT_AMOUNT),
      };
      if (traceId) headers['x-trace-id'] = String(traceId);

      return NextResponse.json(
        {
          ok: false,
          error: irosResult.error,
          detail: irosResult.detail,
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
        { status: 500, headers },
      );
    }

    // assistantText は後で補正するので let
    let { result, finalMode, metaForSave, assistantText } = irosResult as any;

    // =========================================================
    // ✅ Meta/Extra: SpeechPolicy early-return + render-v2 gate clamp
    // - metaForSave / result.meta の参照を1回に統合（重複回避）
    // - expandAllowed=true のとき maxLines を上書きして「5行固定」を潰す
    // =========================================================
    {
      const metaAny: any = metaForSave ?? (result as any)?.meta ?? {};
      const extraAny: any = metaAny?.extra ?? {};

      // -----------------------------------------
      // ✅ render-v2 maxLines fix (route-side gate clamp)
      // -----------------------------------------
      const expandAllowed = extraAny?.expandAllowed === true;
      if (expandAllowed) {
        const expandedMax = 16;

        // ✅ renderEngineGate は boolean なので触らない
        // ✅ renderGateway が読む maxLinesHint だけ確実に上げる
        extraAny.maxLinesHint =
          typeof extraAny?.maxLinesHint === 'number'
            ? Math.max(extraAny.maxLinesHint, expandedMax)
            : expandedMax;

        console.log('[DBG][route][maxLinesHintClamp]', {
          expandAllowed,
          expandedMax,
          maxLinesHint: extraAny.maxLinesHint ?? null,
        });

        metaAny.extra = { ...(metaAny.extra ?? {}), ...extraAny };
        metaForSave = metaAny;
      }


      // -----------------------------------------
      // ✅ SpeechPolicy: SILENCE/FORWARD は即 return
      // -----------------------------------------
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
        };
        if (lowWarn) headers['x-warning'] = 'low_balance';
        if (traceId) headers['x-trace-id'] = String(traceId);

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

    // capture
    const capRes = await captureChat(req, userCode, CREDIT_AMOUNT, creditRef);

    // headers
    const headers: Record<string, string> = {
      ...CORS_HEADERS,
      'x-handler': 'app/api/agent/iros/reply',
      'x-credit-ref': creditRef,
      'x-credit-amount': String(CREDIT_AMOUNT),
    };
    if (lowWarn) headers['x-warning'] = 'low_balance';
    if (traceId) headers['x-trace-id'] = String(traceId);

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
      // meta 組み立て（metaForSave優先）
      let meta: any = {
        ...(metaForSave ?? {}),
        ...(((result as any).meta) ?? {}),
        userProfile:
          (metaForSave as any)?.userProfile ??
          (result as any)?.meta?.userProfile ??
          userProfile ??
          null,
        extra: {
          ...(((metaForSave as any)?.extra) ?? {}),
          ...((((result as any).meta?.extra)) ?? {}),
          userCode: userCode ?? null,
          hintText: hintText ?? null,
          traceId: traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          choiceId: extraMerged.choiceId ?? null,
          extractedChoiceId: extraMerged.extractedChoiceId ?? null,
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

      // rephrase attach（render-v2向け / 1回）
      await maybeAttachRephraseForRenderV2({
        conversationId,
        userCode,
        userText: userTextClean,
        meta,
        extraMerged,
        historyMessages: Array.isArray(chatHistory) ? (chatHistory as any) : null,
        memoryStateForCtx,
        traceId,

        // ✅ routeで確定した最終modeを渡す（ITならrephraseを止める）
        effectiveMode,
      });


      // render engine apply
      const effectiveStyle =
        typeof styleInput === 'string' && styleInput.trim().length > 0
          ? styleInput
          : typeof meta?.style === 'string' && meta.style.trim().length > 0
            ? meta.style
            : typeof meta?.userProfile?.style === 'string' && meta.userProfile.style.trim().length > 0
              ? meta.userProfile.style
              : typeof userProfile?.style === 'string' && userProfile.style.trim().length > 0
                ? userProfile.style
                : null;

// ✅ 置き換え3：applyRenderEngineIfEnabled 呼び出しから styleInput を外す
const enableRenderEngine = Boolean((meta as any)?.extra?.renderEngine);
const isIT = Boolean((meta as any)?.extra?.renderReplyForcedIT);

const applied = applyRenderEngineIfEnabled({
  enableRenderEngine,
  isIT,
  conversationId,
  userCode,
  userText: userTextClean,
  extraForHandle: extraMerged ?? null,
  meta,
  resultObj: result as any,
});

      meta = applied.meta;
      extraMerged = applied.extraForHandle;

      // sanitize header
      {
        const before = String((result as any)?.content ?? '');
        const sanitized = sanitizeFinalContent(before);
        (result as any).content = sanitized.text.trimEnd();
        meta.extra = {
          ...(meta.extra ?? {}),
          finalHeaderStripped: sanitized.removed.length ? sanitized.removed : null,
        };
      }

      // FINAL本文の確定
      {
        const curRaw = String((result as any)?.content ?? '');
        const curTrim = curRaw.trim();

        const speechAct = String(meta?.extra?.speechAct ?? meta?.speechAct ?? '').toUpperCase();
        const silenceReason = pickSilenceReason(meta);
        const isSilent = speechAct === 'SILENCE' && isEffectivelyEmptyText(curTrim);

        const finalText = isSilent
          ? ''
          : isEffectivelyEmptyText(curTrim)
            ? ''
            : curRaw.trimEnd();

        (result as any).content = finalText;
        (result as any).text = finalText;
        (result as any).assistantText = finalText;
        assistantText = finalText;

        meta.extra = {
          ...(meta.extra ?? {}),
          finalAssistantTextSynced: true,
          finalAssistantTextLen: finalText.length,
          finalTextPolicy: isSilent
            ? 'SILENCE_EMPTY_BODY'
            : meta?.extra?.finalTextPolicy ??
              (finalText.length > 0 ? 'NORMAL_BODY' : 'NORMAL_EMPTY_PASS'),
          emptyFinalPatched: finalText.length === 0 ? true : undefined,
          emptyFinalPatchedReason:
            finalText.length === 0
              ? isSilent
                ? (silenceReason ? `SILENCE:${silenceReason}` : 'SILENCE_EMPTY_BODY')
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
        const finalAssistant = String((result as any)?.content ?? '').trim();
        const uiMode = (meta as any)?.mode as ReplyUIMode | undefined;
        const silenceReason = pickSilenceReason(meta);

        // persist 用に q_code / depth_stage を snake_case に同期（最低限）
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
            persistedAssistantMessage: {
              ok: true,
              inserted: false,
              skipped: true,
              reason: 'EMPTY_CONTENT',
            },
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
      const skipTraining =
        meta?.skipTraining === true ||
        meta?.skip_training === true ||
        meta?.recallOnly === true ||
        meta?.recall_only === true;

      if (!skipTraining) {
        await saveIrosTrainingSample({
          supabase,
          userCode,
          tenantId,
          conversationId,
          messageId: null,
          inputText: userTextClean,
          replyText: (result as any).content ?? '',
          meta,
          tags: ['iros', 'auto'],
        });
      } else {
        meta.extra = {
          ...(meta.extra ?? {}),
          trainingSkipped: true,
          trainingSkipReason:
            meta?.skipTraining === true || meta?.skip_training === true
              ? 'skipTraining'
              : 'recallOnly',
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

    // result が string等
    const metaString: any = {
      userProfile: userProfile ?? null,
      extra: {
        userCode,
        hintText,
        traceId,
        historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
        persistedByRoute: true,
        persistAssistantMessage: false,
      },
    };

    const finalText = String(result ?? '').trim();
    {
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
    }

    return NextResponse.json(
      { ...basePayload, content: finalText, meta: metaString },
      { status: 200, headers },
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: 'internal_error', detail: err?.message ?? String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}

// =========================================================
// ✅ RenderEngine 適用（single entry）
// - enableRenderEngine=true の場合は render-v2 (renderGatewayAsReply)
// - IT の場合のみ renderReply（従来）を維持
// =========================================================
function applyRenderEngineIfEnabled(params: {
  enableRenderEngine: boolean;
  isIT: boolean;
  meta: any;
  extraForHandle: any;
  resultObj: any;
  conversationId: string | null;
  userCode: string | null;
  userText: string | null;
}): { meta: any; extraForHandle: any } {
  const {
    enableRenderEngine,
    isIT,
    meta,
    extraForHandle,
    resultObj,
    conversationId,
    userCode,
    userText,
  } = params;

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
        depth:
          (meta as any)?.depth ??
          (meta as any)?.depth_stage ??
          meta?.unified?.depth?.stage ??
          null,
        phase: (meta as any)?.phase ?? meta?.unified?.phase ?? null,
        selfAcceptance:
          (meta as any)?.selfAcceptance ??
          (meta as any)?.self_acceptance ??
          meta?.unified?.selfAcceptance ??
          meta?.unified?.self_acceptance ??
          null,
        yLevel:
          (meta as any)?.yLevel ??
          (meta as any)?.y_level ??
          meta?.unified?.yLevel ??
          meta?.unified?.y_level ??
          null,
        hLevel:
          (meta as any)?.hLevel ??
          (meta as any)?.h_level ??
          meta?.unified?.hLevel ??
          meta?.unified?.h_level ??
          null,
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
          (meta as any)?.situationSummary ??
          (meta as any)?.situation_summary ??
          meta?.unified?.situation?.summary ??
          null,
        situationTopic:
          (meta as any)?.situationTopic ??
          (meta as any)?.situation_topic ??
          meta?.unified?.situation?.topic ??
          null,
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

      const rendered = renderReply(
        (patched.vector ?? vector) as any,
        (patched.input ?? baseInput) as any,
        (patched.opts ?? baseOpts) as any,
      );

      const renderedText =
        typeof rendered === 'string'
          ? rendered
          : (rendered as any)?.text
            ? String((rendered as any).text)
            : String(rendered ?? '');

      const sanitized = sanitizeFinalContent(renderedText);

      const speechActUpper = String(
        (patched.meta as any)?.extra?.speechAct ??
          (patched.meta as any)?.speechAct ??
          '',
      ).toUpperCase();

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
        renderEngineApplied: nextContent.length > 0,
        headerStripped: sanitized.removed.length ? sanitized.removed : null,
      };

      return {
        meta: metaAfter,
        extraForHandle: (patched.extraForHandle ?? extraForHandle) as any,
      };
    } catch (e) {
      meta.extra = {
        ...(meta?.extra ?? {}),
        renderEngineApplied: false,
        renderEngineError: String((e as any)?.message ?? e),
      };
      return { meta, extraForHandle };
    }
  }

  // render無効なら何もしない
  if (!enableRenderEngine) return { meta, extraForHandle };

  // =========================
  // render-v2（renderGatewayAsReply）
  // =========================
  try {
    const extraForRender = {
      ...(meta?.extra ?? {}),
      ...(extraForHandle ?? {}),
      slotPlanPolicy:
        (meta as any)?.framePlan?.slotPlanPolicy ??
        (meta as any)?.slotPlanPolicy ??
        (meta as any)?.extra?.slotPlanPolicy ??
        null,
      framePlan: (meta as any)?.framePlan ?? null,
      slotPlan: (meta as any)?.slotPlan ?? null,

      // EvidenceLogger最小
      conversationId,
      userCode,
      userText: typeof userText === 'string' ? userText : null,
    };

    const maxLines =
      Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)) &&
      Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8;

    // ✅ meta.extra があるなら必ずマージしてから渡す
    const extraMerged = {
      ...(meta?.extra ?? {}),
      ...extraForRender,
    };

// --- BEGIN: ensure rephraseBlocks for render-v2 (RenderBlock[] fallback from final text) ---

type RenderBlock = { text: string | null | undefined; kind?: string };

function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = String(finalText ?? '').trim();
  if (!t) return [];

  const blocksText: string[] = [];

  // 1) [[ILINE]] ... [[/ILINE]] がある場合は、それを先頭ブロックに固定
  const start = t.indexOf('[[ILINE]]');
  const end = t.indexOf('[[/ILINE]]');

  if (start === 0 && end > start) {
    const ilineBlock = t.slice(0, end + '[[/ILINE]]'.length).trim();
    if (ilineBlock) blocksText.push(ilineBlock);

    const rest = t.slice(end + '[[/ILINE]]'.length).trim();
    if (rest) {
      blocksText.push(...rest.split(/\n{2,}/g).map((s) => s.trim()).filter(Boolean));
    }
    return blocksText.map((text) => ({ text }));
  }

  // 2) [[ILINE]] だけ（閉じ無し）：最初の段落を ILINE ブロック扱い
  if (start === 0 && end < 0) {
    const parts = t.split(/\n{2,}/g).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 1) {
      blocksText.push(parts[0]);
      blocksText.push(...parts.slice(1));
      return blocksText.map((text) => ({ text }));
    }
  }

  // 3) 通常：段落（空行区切り）でブロック化
  return t
    .split(/\n{2,}/g)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

(() => {
  const ex: any = extraMerged as any;

  // 既に RenderBlock[] が入ってるなら触らない
  const hasBlocks =
    Array.isArray(ex?.rephraseBlocks) &&
    ex.rephraseBlocks.length > 0 &&
    ex.rephraseBlocks.every((b: any) => b && typeof b === 'object' && 'text' in b);

  const finalTextForBlocks = String(
    ex?.finalAssistantText ??
      ex?.finalAssistantTextCandidate ??
      ex?.resolvedText ??
      ex?.extractedTextFromModel ??
      ''
  ).trim();

  if (!hasBlocks) {
    const fb = buildFallbackRenderBlocksFromFinalText(finalTextForBlocks);
    if (fb.length > 0) {
      ex.rephraseBlocks = fb;
      ex.rephraseApplied = true;
      ex.rephraseReason = ex.rephraseReason ?? 'fallback_blocks_from_final_text';
      ex.rephraseAttachSkipped = false;
    }
  }

  const blocksLen = Array.isArray(ex?.rephraseBlocks) ? ex.rephraseBlocks.length : 0;
  const blocksHead = blocksLen > 0 ? String(ex.rephraseBlocks[0]?.text ?? '').slice(0, 60) : '';

  console.log('[DBG][before-renderGateway][rephraseBlocks]', {
    hasBlocks:
      Array.isArray(ex?.rephraseBlocks) &&
      blocksLen > 0 &&
      ex.rephraseBlocks.every((b: any) => b && typeof b === 'object' && 'text' in b),
    blocksLen,
    blocksHead,
    rephraseApplied: ex?.rephraseApplied ?? null,
    rephraseReason: ex?.rephraseReason ?? null,
  });
})();

// --- END: ensure rephraseBlocks for render-v2 (RenderBlock[] fallback from final text) ---



    console.warn('[DBG][before-renderGateway] extraKeys', Object.keys(extraMerged ?? {}));

    const out = renderGatewayAsReply({
      extra: extraMerged,
      content: (resultObj as any)?.content ?? null,
      assistantText: (resultObj as any)?.assistantText ?? null,
      text: (resultObj as any)?.text ?? null,
      maxLines,
    });

    const nextContent = String(out?.content ?? '').trimEnd();
    resultObj.content = nextContent;
    (resultObj as any).assistantText = nextContent;
    (resultObj as any).text = nextContent;

    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: true,
      renderEngineBy: 'render-v2',
      renderV2: out?.meta ?? null,
    };

    return { meta, extraForHandle };
  } catch (e) {
    console.warn('[IROS/render-v2][ERROR]', {
      message: String((e as any)?.message ?? e),
    });
    return { meta, extraForHandle };
  }
}
