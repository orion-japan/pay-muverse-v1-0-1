// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

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

import { buildResonanceVector } from '@/lib/iros/language/resonanceVector';
import { renderReply } from '@/lib/iros/language/renderReply';
import { renderGatewayAsReply } from '@/lib/iros/language/renderGateway';

import { applyRulebookCompat } from '@/lib/iros/policy/rulebook';
import { persistAssistantMessageToIrosMessages } from '@/lib/iros/server/persistAssistantMessageToIrosMessages';
import { runNormalBase } from '@/lib/iros/conversation/normalBase';
import { loadIrosMemoryState } from '@/lib/iros/memoryState';

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

function pickFallbackAssistantText(args: {
  // NOTE:
  // - assistant の最終フォールバックに userText を使うと「ユーザー文のオウム返し」になり、
  //   outLen が極端に短い/会話が壊れる/ログが誤誘導される原因になる。
  // - ここでは allowUserTextAsLastResort が true でも userText を返さない。
  allowUserTextAsLastResort?: boolean;

  userText?: string | null;

  // 直接指定（従来互換）
  assistantText?: string | null;
  content?: string | null;
  text?: string | null;

  // ✅ 呼び出し側が使っている形（route.ts 内の多数呼び出しを吸収）
  candidates?: any[];

  // 追加があっても崩れないよう、残りはそのまま許容
  [k: string]: any;
}) {
  const norm = (v: any) => String(v ?? '').trim();

  // 0) candidates を最優先で走査（呼び出し側の実態）
  if (Array.isArray(args.candidates) && args.candidates.length > 0) {
    for (const c of args.candidates) {
      const s = norm(c);
      if (s) return s;
    }
  }

  // 1) assistant 系の候補だけを見る（userText は絶対に返さない）
  const a = norm(args.assistantText);
  if (a) return a;

  const c = norm(args.content);
  if (c) return c;

  const x = norm(args.text);
  if (x) return x;

  // 2) 最後まで無ければ空（ここで userText は使わない）
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

    const roleRaw = String(
      (m as any)?.role ?? (m as any)?.speaker ?? (m as any)?.type ?? '',
    )
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
// RenderBlock fallback（route.ts 内で1箇所に統一）
// =========================================================
type RenderBlock = { text: string | null | undefined; kind?: string };

function buildFallbackRenderBlocksFromFinalText(
  finalText: string,
): RenderBlock[] {
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
      blocksText.push(
        ...rest
          .split(/\n{2,}/g)
          .map((s) => s.trim())
          .filter(Boolean),
      );
    }
    return blocksText.map((text) => ({ text }));
  }

  // 2) [[ILINE]] だけ（閉じ無し）：最初の段落を ILINE ブロック扱い
  if (start === 0 && end < 0) {
    const parts = t
      .split(/\n{2,}/g)
      .map((s) => s.trim())
      .filter(Boolean);
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
  effectiveMode?: string | null; // routeで確定した最終mode
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

  const upper = (v: any) => String(v ?? '').trim().toUpperCase();

  // ---------------------------------------------------------
  // SKIP 共通処理（理由を必ずログに残す）
  // ---------------------------------------------------------
  const setSkip = (reason: string, detail?: Record<string, any>) => {
    try {
      const payload = { reason, ...(detail ?? {}) };

      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseAttachSkipped: true,
        rephraseAttachReason: reason,
        rephraseAttachDetail: payload,
        rephraseApplied: false, // 互換
      };

      (extraMerged as any).rephraseAttachSkipped = true;
      (extraMerged as any).rephraseAttachReason = reason;

      console.warn('[IROS/rephraseAttach][SKIP]', {
        conversationId,
        userCode,
        reason,
        effectiveMode: effectiveMode ?? null,
        hintedRenderMode:
          (typeof meta?.renderMode === 'string' && meta.renderMode) ||
          (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
          (typeof meta?.extra?.renderedMode === 'string' &&
            meta.extra.renderedMode) ||
          null,
        speechAct: String(pickSpeechAct(meta) ?? '').toUpperCase() || null,
        traceId: traceId ?? null,
        detail: payload,
      });
    } catch (err) {
      console.error('[IROS/rephraseAttach][SKIP][ERROR]', err);
    }
  };

  // ---------------------------------------------------------
  // DEBUG: rephrase 結果の形を必ず可視化
  // ---------------------------------------------------------
  const debugResShape = (res: any) => {
    try {
      console.info('[IROS/rephraseAttach][DEBUG_SHAPE]', {
        conversationId,
        userCode,
        traceId: traceId ?? null,
        resKeys: res ? Object.keys(res) : [],
        has_blocks: Array.isArray(res?.blocks),
        has_rephraseBlocks: Array.isArray(res?.rephraseBlocks),
        has_rephrase_dot_blocks: Array.isArray(res?.rephrase?.blocks),
        blocksLen: res?.blocks?.length ?? null,
        rephraseBlocksLen: res?.rephraseBlocks?.length ?? null,
        rephraseDotBlocksLen: res?.rephrase?.blocks?.length ?? null,
        head:
          res?.rephraseHead ??
          res?.rephrase?.head ??
          res?.rephrase_text ??
          null,
      });
    } catch {
      // no-op
    }
  };


  const attachFallbackBlocksFromText = (
    finalText: string,
    attachReason: string,
  ) => {
    // ✅ ここは「挙動を変えずに」失敗理由（fb空 / 例外）を確定しつつ、
    // ✅ finalText が空のときだけ “材料” を extra から補う

    const pickFallbackText = () => {
      const fromArg = String(finalText ?? '').trim();
      if (fromArg) return { text: fromArg, from: 'arg:finalText' };

      const fromMetaHead = String((meta?.extra as any)?.rephraseHead ?? '').trim();
      if (fromMetaHead) return { text: fromMetaHead, from: 'meta.extra.rephraseHead' };

      const fromMergedHead = String((extraMerged as any)?.rephraseHead ?? '').trim();
      if (fromMergedHead) return { text: fromMergedHead, from: 'extraMerged.rephraseHead' };

      const fromExtracted = String((extraMerged as any)?.extractedTextFromModel ?? '').trim();
      if (fromExtracted) return { text: fromExtracted, from: 'extraMerged.extractedTextFromModel' };

      const fromRaw = String((extraMerged as any)?.rawTextFromModel ?? '').trim();
      if (fromRaw) return { text: fromRaw, from: 'extraMerged.rawTextFromModel' };

      return { text: '', from: 'none' };
    };

    const picked = pickFallbackText();
    const pickedTrim = picked.text.trim();
    const pickedHead = pickedTrim.slice(0, 120);

    console.info('[IROS/rephraseAttach][FALLBACK_TRY]', {
      conversationId,
      userCode,
      attachReason,
      pickedFrom: picked.from,
      pickedLen: pickedTrim.length,
      pickedHead,
    });

    if (!pickedTrim) {
      console.warn('[IROS/rephraseAttach][FALLBACK_NO_TEXT]', {
        conversationId,
        userCode,
        attachReason,
      });
      return false;
    }

    try {
      const fb = buildFallbackRenderBlocksFromFinalText(pickedTrim);

      if (!Array.isArray(fb) || fb.length === 0) {
        console.warn('[IROS/rephraseAttach][FALLBACK_EMPTY]', {
          conversationId,
          userCode,
          attachReason,
          pickedFrom: picked.from,
          pickedLen: pickedTrim.length,
          pickedHead,
          fbType: Array.isArray(fb) ? 'array' : typeof fb,
        });
        return false;
      }

      // ✅ renderGateway が見ている可能性が高い meta.extra に必ず載せる
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseAttachSkipped: false,
        rephraseAttachReason: attachReason,

        // ✅ fallbackは「LLM rephrase適用」ではない
        rephraseApplied: false,
        rephraseBlocksAttached: true,
        rephraseLLMApplied: false,
        rephraseReason:
          meta?.extra?.rephraseReason ?? 'fallback_blocks_from_text',

        // ✅ blocks
        rephraseBlocks: fb,

        // 参考：head も残しておく（診断用。renderGatewayが拾っても害なし）
        rephraseHead: (meta?.extra as any)?.rephraseHead ?? pickedTrim,
      };

      // extraMerged 側にも互換で載せる
      (extraMerged as any).rephraseBlocks = fb;
      (extraMerged as any).rephraseBlocksAttached = true;
      (extraMerged as any).rephraseLLMApplied = false;
      (extraMerged as any).rephraseApplied = false;
      (extraMerged as any).rephraseAttachSkipped = false;
      (extraMerged as any).rephraseAttachReason = attachReason;
      (extraMerged as any).rephraseReason =
        (extraMerged as any).rephraseReason ?? 'fallback_blocks_from_text';
      (extraMerged as any).rephraseHead =
        (extraMerged as any).rephraseHead ?? pickedTrim;

      console.log('[IROS/rephraseAttach][FALLBACK]', {
        conversationId,
        userCode,
        blocksLen: fb.length,
        head: String(fb[0]?.text ?? '').slice(0, 80),
      });

      console.info('[IROS/rephraseAttach][FALLBACK_APPLIED]', {
        conversationId,
        userCode,
        attachReason,
        pickedFrom: picked.from,
        metaExtraHasBlocks: Array.isArray(meta?.extra?.rephraseBlocks),
        metaExtraBlocksLen: meta?.extra?.rephraseBlocks?.length ?? null,
        mergedExtraHasBlocks: Array.isArray((extraMerged as any)?.rephraseBlocks),
        mergedExtraBlocksLen: (extraMerged as any)?.rephraseBlocks?.length ?? null,
      });

      return true;
    } catch (err: any) {
      console.error('[IROS/rephraseAttach][FALLBACK_ERROR]', {
        conversationId,
        userCode,
        attachReason,
        pickedFrom: picked.from,
        pickedLen: pickedTrim.length,
        pickedHead,
        message: String(err?.message ?? err),
        stack: err?.stack ? String(err.stack).slice(0, 800) : null,
      });
      return false;
    }
  };



  // ---- 1) gate ----
  const enabled =
    String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    setSkip('DISABLED_BY_ENV', { env: 'IROS_REPHRASE_FINAL_ENABLED' });
    return;
  }

  // render-v2 only（routeで確定した extraMerged をソース・オブ・トゥルースにする）
  if (extraMerged?.renderEngine !== true) {
    setSkip('RENDER_ENGINE_OFF', { renderEngine: extraMerged?.renderEngine });
    return;
  }

  // ITでも attach を許可するスイッチ（デフォは止める）
  const allowIT = String(process.env.IROS_REPHRASE_ALLOW_IT ?? '0').trim() === '1';

  // route最終決定がITなら通常は止める（ただしUIのためにfallback blocksは付ける）
  if (!allowIT && upper(effectiveMode) === 'IT') {
    setSkip('SKIP_BY_EFFECTIVE_MODE_IT', { effectiveMode });

    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
      candidates: [
        // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
        (extraMerged as any)?.rephraseHead,
        (meta as any)?.extra?.rephraseHead,

        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
      ],

    });

    attachFallbackBlocksFromText(fallbackText, 'FALLBACK_IT_SKIP');
    return;
  }

  const hintedRenderMode =
    (typeof meta?.renderMode === 'string' && meta.renderMode) ||
    (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
    (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
    '';

  if (!allowIT && upper(hintedRenderMode) === 'IT') {
    setSkip('SKIP_BY_HINTED_RENDER_MODE_IT', { hintedRenderMode });

    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
      candidates: [
        // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
        (extraMerged as any)?.rephraseHead,
        (meta as any)?.extra?.rephraseHead,

        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
      ],

    });

    attachFallbackBlocksFromText(fallbackText, 'FALLBACK_HINTED_IT_SKIP');
    return;
  }

  const speechAct = upper(pickSpeechAct(meta));
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') {
    setSkip('SKIP_BY_SPEECH_ACT', { speechAct });
    // ここは空でOK（SILENCE/FORWARDはrouteで早期returnされる）
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

  // slots が無いなら LLM rephrase はしないが、UIブロックは必ず付ける
  if (!extracted?.slots?.length) {
    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
      candidates: [
        // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
        (extraMerged as any)?.rephraseHead,
        (meta as any)?.extra?.rephraseHead,

        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
      ],



    });

    const ok = attachFallbackBlocksFromText(
      fallbackText,
      'FALLBACK_FROM_RESULT_TEXT_NO_SLOTS',
    );
    if (!ok) setSkip('NO_SLOTS_FOR_REPHRASE');
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

    const qCodeForLLM =
      (typeof (meta as any)?.q_code === 'string' &&
        String((meta as any).q_code).trim()) ||
      (typeof (meta as any)?.qCode === 'string' &&
        String((meta as any).qCode).trim()) ||
      (typeof (meta as any)?.qPrimary === 'string' &&
        String((meta as any).qPrimary).trim()) ||
      (typeof (meta as any)?.unified?.q?.current === 'string' &&
        String((meta as any).unified.q.current).trim()) ||
      null;

    const depthForLLM =
      (typeof (meta as any)?.depth_stage === 'string' &&
        String((meta as any).depth_stage).trim()) ||
      (typeof (meta as any)?.depthStage === 'string' &&
        String((meta as any).depthStage).trim()) ||
      (typeof (meta as any)?.depth === 'string' &&
        String((meta as any).depth).trim()) ||
      (typeof (meta as any)?.unified?.depth?.stage === 'string' &&
        String((meta as any).unified.depth.stage).trim()) ||
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
        mode: effectiveMode ?? null,
        qCode: qCodeForLLM,
        depthStage: depthForLLM,
      },
    });

// DEBUG: rephraseSlotsFinal の返却 "res" の形を確定（blocks がどこにあるか）
// - IROS_DEBUG_REPHRASE_PIPE=1 のときだけ出す
if (String(process.env.IROS_DEBUG_REPHRASE_PIPE ?? '0').trim() === '1') {
  const safeKeys = (obj: any) => (obj && typeof obj === 'object' ? Object.keys(obj) : []);
  const typeOf = (v: any) =>
    Array.isArray(v) ? `array(len=${v.length})` : v === null ? 'null' : typeof v;

  const extra = (res as any)?.extra;
  const rephrase = (res as any)?.rephrase;

  const candidates: Record<string, any> = {
    'res.blocks': (res as any)?.blocks,
    'res.rephraseBlocks': (res as any)?.rephraseBlocks,
    'res.rephrase.blocks': rephrase?.blocks,
    'res.rephrase.rephraseBlocks': rephrase?.rephraseBlocks,
    'res.extra.rephraseBlocks': extra?.rephraseBlocks,
    'res.extra.rephrase.blocks': extra?.rephrase?.blocks,
    'res.extra.rephrase.rephraseBlocks': extra?.rephrase?.rephraseBlocks,
    'res.extra.blocks': extra?.blocks,
  };

  const candSummary = Object.entries(candidates).map(([k, v]) => ({
    k,
    t: typeOf(v),
    keys: !Array.isArray(v) && v && typeof v === 'object' ? Object.keys(v).slice(0, 8) : null,
  }));

  const samplePick =
    (res as any)?.rephraseHead ??
    (res as any)?.rephrase?.head ??
    (res as any)?.extra?.rephraseHead ??
    null;

  console.info('[IROS/rephraseAttach][RES_SHAPE]', {
    conversationId,
    userCode,
    resKeys: safeKeys(res as any).slice(0, 30),
    resExtraKeys: safeKeys(extra).slice(0, 30),
    resRephraseKeys: safeKeys(rephrase).slice(0, 30),
    candidateSummary: candSummary,
    sampleHead: typeof samplePick === 'string' ? samplePick.slice(0, 120) : samplePick,
  });
}



    if (!res.ok) {
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseAttachSkipped: false,
        rephraseBlocksAttached: false,
        rephraseLLMApplied: false,
        rephraseApplied: false,
        rephraseReason: res.reason ?? 'unknown',
      };

      (extraMerged as any).rephraseAttachSkipped = false;
      (extraMerged as any).rephraseBlocksAttached = false;
      (extraMerged as any).rephraseLLMApplied = false;
      (extraMerged as any).rephraseApplied = false;
      (extraMerged as any).rephraseReason = res.reason ?? 'unknown';

      // 失敗でもUIブロックだけは付ける
      const fallbackText = pickFallbackAssistantText({
        allowUserTextAsLastResort: true,
        userText,
        candidates: [
          // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
          (extraMerged as any)?.rephraseHead,
          (meta as any)?.extra?.rephraseHead,
          (res as any)?.rephraseHead,

          (extraMerged as any)?.extractedTextFromModel,
          (extraMerged as any)?.rawTextFromModel,
          (extraMerged as any)?.finalAssistantText,
          (extraMerged as any)?.finalAssistantTextCandidate,
          (extraMerged as any)?.resolvedText,
          (extraMerged as any)?.assistantText,
          (extraMerged as any)?.content,
          (extraMerged as any)?.text,
        ],

      });

      attachFallbackBlocksFromText(fallbackText, 'FALLBACK_REPHRASE_FAIL');
      return;
    }

    const blocks =
      Array.isArray((res as any)?.blocks)
        ? (res as any).blocks
        : Array.isArray((res as any)?.rephraseBlocks)
          ? (res as any).rephraseBlocks
          : Array.isArray((res as any)?.rephrase?.rephraseBlocks)
            ? (res as any).rephrase.rephraseBlocks
            : Array.isArray((res as any)?.rephrase?.blocks)
              ? (res as any).rephrase.blocks

              // ✅ 追加：rephraseEngine は res.meta.extra に付けて返す（ここが本命）
              : Array.isArray((res as any)?.meta?.extra?.rephraseBlocks)
                ? (res as any).meta.extra.rephraseBlocks
                : Array.isArray((res as any)?.meta?.extra?.rephrase?.rephraseBlocks)
                  ? (res as any).meta.extra.rephrase.rephraseBlocks
                  : Array.isArray((res as any)?.meta?.extra?.rephrase?.blocks)
                    ? (res as any).meta.extra.rephrase.blocks

                    // 互換：res.extra は古い経路
                    : Array.isArray((res as any)?.extra?.rephraseBlocks)
                      ? (res as any).extra.rephraseBlocks
                      : Array.isArray((res as any)?.extra?.rephrase?.rephraseBlocks)
                        ? (res as any).extra.rephrase.rephraseBlocks
                        : Array.isArray((res as any)?.extra?.rephrase?.blocks)
                          ? (res as any).extra.rephrase.blocks
                          : [];


                    if (!blocks.length) {
                      // ✅ 1) res 側の “形ズレ” を吸収して拾う（route 内で blocks が空でも、res に入ってる可能性がある）
                      const blocksFromRes =
                        (res as any)?.blocks ??
                        (res as any)?.rephraseBlocks ??
                        (res as any)?.rephrase?.blocks ??
                        (res as any)?.rephrase?.rephraseBlocks ??
                        null;

                      if (Array.isArray(blocksFromRes) && blocksFromRes.length > 0) {
                        (extraMerged as any).rephraseBlocks = blocksFromRes;

                        meta.extra = {
                          ...(meta.extra ?? {}),
                          rephraseAttachSkipped: false,
                          rephraseBlocksAttached: true,
                          rephraseLLMApplied: true,
                          rephraseApplied: true,
                          rephraseReason: (res as any)?.reason ?? 'ok',
                          rephraseBlocks: blocksFromRes,
                        };

                        (extraMerged as any).rephraseBlocksAttached = true;
                        (extraMerged as any).rephraseApplied = true;
                        (extraMerged as any).rephraseLLMApplied = true;
                        (extraMerged as any).rephraseAttachSkipped = false;
                        (extraMerged as any).rephraseReason = (res as any)?.reason ?? 'ok';

                        console.log('[IROS/rephraseAttach][FROM_RES_BLOCKS]', {
                          conversationId,
                          userCode,
                          blocksLen: blocksFromRes.length,
                        });

                        return;
                      }

// ✅ 2) rephraseEngine が extraMerged/meta.extra に既に付けた blocks を “採用”する（ここが本命）
// さらに：res 側に blocks が載っているケースも拾う（attach 前に extraMerged に反映されてない事故を吸収）
const blocksFromExtra =
  // res 側（最優先で拾う）
  (res as any)?.rephraseBlocks ??
  (res as any)?.rephrase?.rephraseBlocks ??
  (res as any)?.rephrase?.blocks ??
  (res as any)?.blocks ??

  // extraMerged 側
  (extraMerged as any)?.rephraseBlocks ??
  (extraMerged as any)?.rephrase?.rephraseBlocks ??
  (extraMerged as any)?.rephrase?.blocks ??
  (extraMerged as any)?.rephrase_blocks ??

  // meta.extra 側
  (meta as any)?.extra?.rephraseBlocks ??
  (meta as any)?.extra?.rephrase?.rephraseBlocks ??
  (meta as any)?.extra?.rephrase?.blocks ??
  (meta as any)?.extra?.rephrase_blocks ??
  null;

  if (Array.isArray(blocksFromExtra) && blocksFromExtra.length > 0) {
    const headFromExtra =
      String(
        (res as any)?.meta?.extra?.rephraseHead ??
          (res as any)?.meta?.rephraseHead ??
          (res as any)?.meta?.rawHead ??
          '',
      ).trim() ||
      // 予備：blocks 先頭から作る（空を許さない）
      String(blocksFromExtra[0] ?? '').trim();

    (extraMerged as any).rephraseBlocks = blocksFromExtra;
    (extraMerged as any).rephraseHead = headFromExtra;

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: true,
      rephraseApplied: true,
      rephraseReason: (res as any)?.reason ?? 'ok',
      rephraseBlocks: blocksFromExtra,
      rephraseHead: headFromExtra,
    };

    (extraMerged as any).rephraseBlocksAttached = true;
    (extraMerged as any).rephraseApplied = true;
    (extraMerged as any).rephraseLLMApplied = true;
    (extraMerged as any).rephraseAttachSkipped = false;
    (extraMerged as any).rephraseReason = (res as any)?.reason ?? 'ok';

    console.log('[IROS/rephraseAttach][ADOPT_EXISTING_BLOCKS]', {
      conversationId,
      userCode,
      blocksLen: blocksFromExtra.length,
      headLen: String(headFromExtra ?? '').length,
    });

    return;
  }


                      // ✅ 3) ここで “SKIP” しない（SKIP すると renderGateway 側で拾えず WARN_NO_REPHRASE_BLOCKS になりやすい）
                      console.warn('[IROS/rephraseAttach][NO_BLOCKS_ANYWHERE] -> FALLBACK_ATTACH', {
                        conversationId,
                        userCode,
                        resReason: (res as any)?.reason ?? null,
                      });

                      const fallbackText = pickFallbackAssistantText({
                        allowUserTextAsLastResort: true,
                        userText,
                        candidates: [
                          // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
                          (extraMerged as any)?.rephraseHead,
                          (meta as any)?.extra?.rephraseHead,
                          (res as any)?.rephraseHead,

                          (extraMerged as any)?.extractedTextFromModel,
                          (extraMerged as any)?.rawTextFromModel,
                          (extraMerged as any)?.finalAssistantText,
                          (extraMerged as any)?.finalAssistantTextCandidate,
                          (extraMerged as any)?.resolvedText,
                          (extraMerged as any)?.assistantText,
                          (extraMerged as any)?.content,
                          (extraMerged as any)?.text,
                        ],

                      });

                      attachFallbackBlocksFromText(fallbackText, 'FALLBACK_NO_BLOCKS');

                      meta.extra = {
                        ...(meta.extra ?? {}),
                        rephraseAttachSkipped: false,
                        rephraseBlocksAttached: true,
                        rephraseLLMApplied: true,
                        rephraseApplied: true,
                        rephraseReason: 'FALLBACK_NO_BLOCKS',
                      };

                      (extraMerged as any).rephraseBlocksAttached = true;
                      (extraMerged as any).rephraseLLMApplied = true;
                      (extraMerged as any).rephraseApplied = true;
                      (extraMerged as any).rephraseAttachSkipped = false;
                      (extraMerged as any).rephraseReason = 'FALLBACK_NO_BLOCKS';

                      return;
                    }


    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: true,

      // 互換：LLM rephrase成功 = true
      rephraseApplied: true,
      rephraseReason: (res as any)?.reason ?? 'ok',
    };

    (extraMerged as any).rephraseBlocks = blocks;
    (extraMerged as any).rephraseBlocksAttached = true;
    (extraMerged as any).rephraseLLMApplied = true;
    (extraMerged as any).rephraseApplied = true;
    (extraMerged as any).rephraseAttachSkipped = false;
    (extraMerged as any).rephraseReason = (res as any)?.reason ?? 'ok';

    console.log('[IROS/rephraseAttach][OK]', {
      conversationId,
      userCode,
      blocksLen: blocks.length,
    });
  } catch (e: any) {
    setSkip('REPHRASE_CALL_THROW', { message: String(e?.message ?? e) });

    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
      candidates: [
        // ✅ rephrase の head は “最低限の本文” なので fallback に必ず入れる
        (extraMerged as any)?.rephraseHead,
        (meta as any)?.extra?.rephraseHead,

        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
      ],

    });

    attachFallbackBlocksFromText(fallbackText, 'FALLBACK_THROW');
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
          error: (irosResult as any).error,
          detail: (irosResult as any).detail,
          credit: { ref: creditRef, amount: CREDIT_AMOUNT, authorize: authRes },
        },
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

      // render-v2 maxLines fix
      const expandAllowed = extraAny?.expandAllowed === true;
      if (expandAllowed) {
        const expandedMax = 16;
        extraAny.maxLinesHint =
          typeof extraAny?.maxLinesHint === 'number'
            ? Math.max(extraAny.maxLinesHint, expandedMax)
            : expandedMax;

        metaAny.extra = { ...(metaAny.extra ?? {}), ...extraAny };
        metaForSave = metaAny;
      }

      // SpeechPolicy: SILENCE/FORWARD は即 return
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
      (typeof metaForSave?.extra?.renderedMode === 'string' &&
        metaForSave.extra.renderedMode) ||
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
      // meta 組み立て（✅ metaForSave優先にする：result.meta を先に、metaForSave を後に）
      let meta: any = {
        ...(((result as any).meta) ?? {}),
        ...(metaForSave ?? {}),
        userProfile:
          (metaForSave as any)?.userProfile ??
          (result as any)?.meta?.userProfile ??
          userProfile ??
          null,
        extra: {
          ...((((result as any).meta?.extra)) ?? {}),
          ...(((metaForSave as any)?.extra) ?? {}),

          userCode: userCode ?? null,
          hintText: hintText ?? null,
          traceId: traceId ?? null,
          historyLen: Array.isArray(chatHistory) ? chatHistory.length : 0,
          choiceId: extraMerged.choiceId ?? null,
          extractedChoiceId: extraMerged.extractedChoiceId ?? null,

          // ✅ routeで確定した gate を meta にも同期（判定ブレ防止）
          renderEngineGate: extraMerged.renderEngineGate === true,
          renderEngine: extraMerged.renderEngine === true,

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
          (typeof (meta as any)?.unified?.q?.current === 'string' &&
            (meta as any).unified.q.current) ||
          null,
        depth:
          (typeof (meta as any)?.depth === 'string' && (meta as any).depth) ||
          (typeof (meta as any)?.depth_stage === 'string' && (meta as any).depth_stage) ||
          (typeof (meta as any)?.unified?.depth?.stage === 'string' &&
            (meta as any).unified.depth.stage) ||
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
        effectiveMode,
      });

// DEBUG: attach直後に rephraseBlocks がどこにあるか確証
if (String(process.env.IROS_DEBUG_REPHRASE_PIPE ?? '0').trim() === '1') {
  const bMeta =
    (meta as any)?.extra?.rephraseBlocks ??
    (meta as any)?.extra?.rephrase?.blocks ??
    (meta as any)?.extra?.rephrase?.rephraseBlocks ??
    null;

  const bMerged =
    (extraMerged as any)?.rephraseBlocks ??
    (extraMerged as any)?.rephrase?.blocks ??
    (extraMerged as any)?.rephrase?.rephraseBlocks ??
    null;

  console.info('[IROS/pipe][AFTER_ATTACH]', {
    conversationId,
    userCode,
    metaExtraHasBlocks: Array.isArray(bMeta),
    metaExtraBlocksLen: Array.isArray(bMeta) ? bMeta.length : null,
    mergedExtraHasBlocks: Array.isArray(bMerged),
    mergedExtraBlocksLen: Array.isArray(bMerged) ? bMerged.length : null,
    mergedHead: Array.isArray(bMerged) ? String(bMerged[0]?.text ?? '').slice(0, 80) : null,
  });
}

  // ✅ handleIrosReply 側で attach された meta / extra を route の extraMerged に吸収する
  // （render-v2 の source-of-truth は route の extraMerged）
  try {
    // ✅ meta.extra だけで確定させない：extraForHandle（blocks が来やすい）も必ず合流させる
    const metaAny =
      (irosResult as any)?.metaForSave ??
      (irosResult as any)?.meta ??
      null;

    const metaExtraA = (metaAny as any)?.extra ?? null;                 // meta.extra
    const metaExtraB = (irosResult as any)?.extraForHandle ?? null;     // handleIrosReply 由来（blocks が来やすい）
    const metaExtraC = (irosResult as any)?.extra ?? null;              // result.extra
    const metaExtraD = (irosResult as any)?.metaExtra ?? null;          // metaExtra

    const hasObj = (x: any) => x && typeof x === 'object';

    // ✅ 衝突時は既存優先（extraMerged を最後に）
    const mergedFromMeta =
      (hasObj(metaExtraA) || hasObj(metaExtraB) || hasObj(metaExtraC) || hasObj(metaExtraD))
        ? {
            ...(hasObj(metaExtraA) ? metaExtraA : {}),
            ...(hasObj(metaExtraB) ? metaExtraB : {}),
            ...(hasObj(metaExtraC) ? metaExtraC : {}),
            ...(hasObj(metaExtraD) ? metaExtraD : {}),
            ...(extraMerged ?? {}),
          }
        : null;

    if (mergedFromMeta) {
      extraMerged = mergedFromMeta;

      // blocks / head は明示的に拾っておく（extraMerged に無い場合だけ）
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

      if (
        !Array.isArray((extraMerged as any).rephraseBlocks) &&
        Array.isArray(blocks) &&
        blocks.length > 0
      ) {
        (extraMerged as any).rephraseBlocks = blocks;
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

      if (!(extraMerged as any).rephraseHead && head) {
        (extraMerged as any).rephraseHead = head;
      }

      console.info('[IROS/pipe][META_EXTRA_MERGED]', {
        metaSource: (irosResult as any)?.metaForSave ? 'metaForSave' : ((irosResult as any)?.meta ? 'meta' : 'none'),
        metaExtraSources: {
          meta_extra: hasObj(metaExtraA),
          extraForHandle: hasObj(metaExtraB),
          result_extra: hasObj(metaExtraC),
          metaExtra: hasObj(metaExtraD),
        },
        mergedExtraHasBlocks: Array.isArray((extraMerged as any).rephraseBlocks),
        mergedExtraBlocksLen: (extraMerged as any).rephraseBlocks?.length ?? null,
        mergedHead: (extraMerged as any).rephraseHead
          ? String((extraMerged as any).rephraseHead).slice(0, 80)
          : null,
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


      // render engine apply（single entry）
      {
        // ✅ enable判定は routeで確定した extraMerged をソースにする（metaの欠落でOFFにならない）
        const enableRenderEngine =
          extraMerged?.renderEngine === true || extraMerged?.renderEngineGate === true;

        const upperMode = String(effectiveMode ?? '').toUpperCase();
        const isIT =
          upperMode === 'IT' || Boolean((meta as any)?.extra?.renderReplyForcedIT);

        // ✅ apply前の rephraseBlocks/head を退避（apply 側が extra を作り直しても落とさない）
        const extraBefore: any = extraMerged ?? null;

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
// ✅ rephraseEngine の戻りを carry で参照するための受け皿
let rephraseOut: any = null;
        // ✅ apply 後に rephraseBlocks/head が落ちた場合、必ず carry する（配線の最終保険）
        try {
// ✅ carry の“元”は extraBefore じゃなくて、handle/rephrase の result から拾う
const pickBlocks = (x: any) =>
  x?.rephraseBlocks ?? x?.rephrase?.blocks ?? x?.rephrase?.rephraseBlocks ?? null;

const pickHead = (x: any) => {
  const h = String(x?.rephraseHead ?? x?.rephrase?.head ?? '').trim();
  return h ? h : null;
};

// ✅ ここが重要：result/meta の中の候補を総当りで拾う
// ✅ carrySource は “rephraseEngine の戻り” を最優先にする
const carrySource =
  (rephraseOut as any)?.extra ??
  (rephraseOut as any)?.meta?.extra ??
  (rephraseOut as any) ??
  extraBefore;

const beforeBlocks = pickBlocks(carrySource);
const beforeHead = pickHead(carrySource);



          // extraMerged 側
          if (extraMerged && typeof extraMerged === 'object') {
            if (
              !Array.isArray((extraMerged as any).rephraseBlocks) &&
              Array.isArray(beforeBlocks) &&
              beforeBlocks.length > 0
            ) {
              (extraMerged as any).rephraseBlocks = beforeBlocks;
              (extraMerged as any).rephraseBlocksAttached = true;
            }
            if (!(extraMerged as any).rephraseHead && beforeHead) {
              (extraMerged as any).rephraseHead = beforeHead;
            }
          }

          // meta.extra 側（renderGateway が見に行く先を必ず満たす）
          if (meta && typeof meta === 'object') {
            (meta as any).extra = { ...((meta as any).extra ?? {}) };

            const metaBlocks = pickBlocks((meta as any).extra);
            const metaHead = pickHead((meta as any).extra);

            if (
              !Array.isArray(metaBlocks) &&
              Array.isArray(beforeBlocks) &&
              beforeBlocks.length > 0
            ) {
              (meta as any).extra.rephraseBlocks = beforeBlocks;
              (meta as any).extra.rephraseBlocksAttached = true;
            }
            if (!metaHead && beforeHead) {
              (meta as any).extra.rephraseHead = beforeHead;
            }
          }

        } catch (e) {
          console.warn('[IROS/pipe][APPLY_RENDER_ENGINE][CARRY_REPHRASE][ERROR]', e);
        }
      }


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

        const emptyLike = isEffectivelyEmptyText(curTrim);
        const userNonEmpty = String(userTextClean ?? '').trim().length > 0;

        // ✅ SILENCE は「空入力専用」を原則にする（誤SILENCEで無言化させない）
        const silentAllowed = !userNonEmpty;
        const isSilent = speechAct === 'SILENCE' && emptyLike && silentAllowed;

        // ✅ ここが本丸：renderGateway が outLen=0 を返しても、
        // extraMerged に rephraseHead / rephraseBlocks が残っているなら本文を復元する
        const ex: any = extraMerged as any;
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

        // 1) SILENCE → 常に空
        // 2) 非SILENCEで emptyLike だが復元できる → 復元を採用
        // 3) それ以外 → curRaw を採用
        const finalText = isSilent
          ? ''
          : emptyLike
            ? (recoveredText ? recoveredText : '')
            : curRaw.trimEnd();

        // DEBUG: 必要な時だけ確証ログ
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
            mergedExtraHasBlocks: Array.isArray(ex?.rephraseBlocks),
            mergedExtraBlocksLen: Array.isArray(ex?.rephraseBlocks) ? ex.rephraseBlocks.length : null,
            mergedHeadLen: head ? head.length : 0,
            recoveredFromBlocksLen: recoveredFromBlocks.length,
            finalTextLen: finalText.length,
            finalTextPolicyCandidate: isSilent
              ? (silenceReason ? `SILENCE:${silenceReason}` : 'SILENCE_EMPTY_BODY')
              : emptyLike
                ? (recoveredText ? 'RECOVERED_FROM_EXTRA' : 'NON_SILENCE_EMPTY_CONTENT')
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
          finalTextRecoveredFromExtra: emptyLike && !isSilent && Boolean(recoveredText) ? true : undefined,
          finalTextRecoveredSource:
            emptyLike && !isSilent && Boolean(recoveredText)
              ? (head ? 'rephraseHead' : 'rephraseBlocks')
              : undefined,
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

        // routeのgateを同期（文字列resultでもUI判定がブレない）
        renderEngineGate: extraMerged.renderEngineGate === true,
        renderEngine: extraMerged.renderEngine === true,
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
// - 返り値は必ず { meta, extraForHandle } に統一
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
        qCode:
          (meta as any)?.qCode ??
          (meta as any)?.q_code ??
          meta?.unified?.q?.current ??
          null,
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
        renderEngineApplied: true,
        renderEngineKind: 'IT',
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
        renderEngineKind: 'IT',
        renderEngineError: String((e as any)?.message ?? e),
      };
      return { meta, extraForHandle };
    }
  }

  // render無効なら何もしない
  if (!enableRenderEngine) {
    meta.extra = {
      ...(meta?.extra ?? {}),
      renderEngineApplied: false,
      renderEngineKind: 'OFF',
    };
    return { meta, extraForHandle };
  }

  // =========================
  // render-v2（renderGatewayAsReply）
  // =========================
  try {
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
      Number.isFinite(Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)) &&
      Number(process.env.IROS_RENDER_DEFAULT_MAXLINES) > 0
        ? Number(process.env.IROS_RENDER_DEFAULT_MAXLINES)
        : 8;

    const baseText = String(
      (resultObj as any)?.assistantText ??
        (resultObj as any)?.content ??
        (resultObj as any)?.text ??
        '',
    ).trimEnd();

    // extraMerged（配線の“最終実態”）
    const extraMerged = ((params as any).extraForHandle ??
      (params as any).extraMerged ??
      (params as any).extra) as any;

    // ✅ 最終保険：renderGateway に渡す直前に、必ず rephraseBlocks を持たせる（まずは extraMerged 側を確定）
    if (enableRenderEngine) {
      const hasBlocks =
        Array.isArray((extraMerged as any)?.rephraseBlocks) &&
        (extraMerged as any).rephraseBlocks.length > 0;

      if (!hasBlocks) {
        const best =
          String((extraMerged as any)?.rephraseHead ?? '').trim() ||
          String((extraMerged as any)?.extractedTextFromModel ?? '').trim() ||
          String((extraMerged as any)?.rawTextFromModel ?? '').trim() ||
          String((extraMerged as any)?.finalAssistantText ?? '').trim() ||
          String((extraMerged as any)?.resolvedText ?? '').trim() ||
          String((extraMerged as any)?.assistantText ?? '').trim() ||
          String((extraMerged as any)?.content ?? '').trim() ||
          String((extraMerged as any)?.text ?? '').trim() ||
          String(baseText ?? '').trim();

        if (best) {
          const fb = buildFallbackRenderBlocksFromFinalText(best);

          (extraMerged as any).rephraseBlocks = fb;
          (extraMerged as any).rephraseBlocksAttached = true;
          (extraMerged as any).rephraseAttachSkipped = false;

          // 既存の状態を壊さない（true/false を上書きで決めない）
          (extraMerged as any).rephraseLLMApplied = Boolean(
            (extraMerged as any)?.rephraseLLMApplied,
          );
          (extraMerged as any).rephraseApplied = Boolean(
            (extraMerged as any)?.rephraseApplied,
          );

          (extraMerged as any).rephraseReason =
            (extraMerged as any)?.rephraseReason ??
            'final_fallback_blocks_from_best_text';
          (extraMerged as any).rephraseHead =
            (extraMerged as any)?.rephraseHead ?? best;

          console.warn('[IROS/rephraseAttach][FINAL_FALLBACK_BLOCKS]', {
            blocksLen: fb.length,
            head: String(best).slice(0, 120),
          });
        } else {
          console.warn(
            '[IROS/rephraseAttach][FINAL_FALLBACK_BLOCKS][NO_TEXT]',
            {
              hasRephraseHead: Boolean((extraMerged as any)?.rephraseHead),
              hasExtracted: Boolean((extraMerged as any)?.extractedTextFromModel),
              hasRaw: Boolean((extraMerged as any)?.rawTextFromModel),
              hasFinal: Boolean((extraMerged as any)?.finalAssistantText),
            },
          );
        }
      }
    }

    // ✅ 重要：最終確定した extraMerged の rephraseBlocks/head を、render に渡す extraForRender に同期する
    if (enableRenderEngine) {
      const mergedBlocks = (extraMerged as any)?.rephraseBlocks;
      if (
        Array.isArray(mergedBlocks) &&
        mergedBlocks.length > 0 &&
        !Array.isArray((extraForRender as any)?.rephraseBlocks)
      ) {
        (extraForRender as any).rephraseBlocks = mergedBlocks;
      }

      const mergedHead = String((extraMerged as any)?.rephraseHead ?? '').trim();
      if (mergedHead && !String((extraForRender as any)?.rephraseHead ?? '').trim()) {
        (extraForRender as any).rephraseHead = mergedHead;
      }

      // 付随フラグも “存在するものだけ” 反映（壊さない）
      const keysToCarry = [
        'rephraseBlocksAttached',
        'rephraseAttachSkipped',
        'rephraseLLMApplied',
        'rephraseApplied',
        'rephraseReason',
      ] as const;

      for (const k of keysToCarry) {
        if ((extraForRender as any)[k] == null && (extraMerged as any)[k] != null) {
          (extraForRender as any)[k] = (extraMerged as any)[k];
        }
      }
    }

    const out = renderGatewayAsReply({
      text: baseText,
      extra: extraForRender,
      maxLines,
    }) as any;


    // =========================================================
    // DEBUG: rephraseBlocks が「renderGateway に渡る直前」に存在するか確証を取る
    // - IROS_DEBUG_REPHRASE_PIPE=1 のときだけ出す
    // =========================================================
    if (String(process.env.IROS_DEBUG_REPHRASE_PIPE ?? '0').trim() === '1') {
      const metaBlocks =
        (meta as any)?.extra?.rephraseBlocks ??
        (meta as any)?.extra?.rephrase?.blocks ??
        (meta as any)?.extra?.rephrase?.rephraseBlocks ??
        null;

      const handleBlocks =
        (extraForHandle as any)?.rephraseBlocks ??
        (extraForHandle as any)?.rephrase?.blocks ??
        (extraForHandle as any)?.rephrase?.rephraseBlocks ??
        null;

      const mergedBlocks =
        (extraForRender as any)?.rephraseBlocks ??
        (extraForRender as any)?.rephrase?.blocks ??
        (extraForRender as any)?.rephrase?.rephraseBlocks ??
        null;

      console.info('[IROS/pipe][BEFORE_RENDER_V2]', {
        conversationId,
        userCode,
        metaExtraHasBlocks: Array.isArray(metaBlocks),
        metaExtraBlocksLen: Array.isArray(metaBlocks) ? metaBlocks.length : null,
        handleExtraHasBlocks: Array.isArray(handleBlocks),
        handleExtraBlocksLen: Array.isArray(handleBlocks) ? handleBlocks.length : null,
        mergedExtraHasBlocks: Array.isArray(mergedBlocks),
        mergedExtraBlocksLen: Array.isArray(mergedBlocks) ? mergedBlocks.length : null,
        mergedHead: Array.isArray(mergedBlocks) ? String(mergedBlocks[0]?.text ?? '').slice(0, 80) : null,
      });
    }

    const outText = String(
      (typeof out === 'string'
        ? out
        : out?.text ?? out?.content ?? out?.assistantText ?? baseText) ?? '',
    ).trimEnd();

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

    return { meta, extraForHandle };
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
