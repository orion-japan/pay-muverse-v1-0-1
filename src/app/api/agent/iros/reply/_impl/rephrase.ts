// src/app/api/agent/iros/reply/_impl/rephrase.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { pickSpeechAct } from '../_helpers';
import { extractSlotsForRephrase, rephraseSlotsFinal } from '@/lib/iros/language/rephraseEngine';

type RenderBlock = { text: string | null | undefined; kind?: string };

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

    const body = String((m as any)?.content ?? (m as any)?.text ?? (m as any)?.message ?? '')
      .replace(/\r\n/g, '\n')
      .trim();

    if (!body) continue;

    const isAssistant =
      roleRaw === 'assistant' || roleRaw === 'bot' || roleRaw === 'system' || roleRaw.startsWith('a');

    out.push({
      role: (isAssistant ? 'assistant' : 'user') as 'assistant' | 'user',
      content: body,
    });
  }
  return out.slice(-12);
}

function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = String(finalText ?? '').trim();
  if (!t) return [];

  const splitToBlocks = (s: string): string[] => {
    const raw = String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    if (!raw) return [];
    if (/\n{2,}/.test(raw)) {
      return raw
        .split(/\n{2,}/g)
        .map((x) => x.trim())
        .filter(Boolean);
    }
    if (raw.includes('\n')) {
      return raw
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean);
    }
    return [raw];
  };

  const blocksText: string[] = [];

  // 1) [[ILINE]]...[[/ILINE]] が先頭にあるなら先頭ブロック固定
  const start = t.indexOf('[[ILINE]]');
  const end = t.indexOf('[[/ILINE]]');
  let rest = t;

  if (start === 0 && end > start) {
    const ilineBlock = t.slice(0, end + '[[/ILINE]]'.length).trim();
    if (ilineBlock) blocksText.push(ilineBlock);
    rest = t.slice(end + '[[/ILINE]]'.length).trim();
  }

  // 2) 残りを段落/行でブロック化
  const tailBlocks = splitToBlocks(rest);
  for (const b of tailBlocks) blocksText.push(b);

  return blocksText.map((text) => ({ text, kind: 'p' }));
}

/**
 * userText を「絶対に本文候補にしない」安全版 fallback picker
 * - EMPTY_LIKE（…… / ...）は捨てる
 * - @OBS/@SHIFT など内部マーカーは捨てる
 */
function pickSafeAssistantText(args: {
  assistantText?: string | null;
  content?: string | null;
  text?: string | null;
  candidates?: any[];
}) {
  const norm = (v: any) =>
    String(v ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

  const isEmptyLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return true;
    // "……" / "..." / "・・・・" 的なやつ
    if (/^[.。・…]{2,}$/u.test(s)) return true;
    if (/^…+$/.test(s)) return true;
    return false;
  };

  const isInternalLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return false;
    if (/^@(OBS|SHIFT)\b/m.test(s)) return true;
    if (/^\s*\{.*"role"\s*:\s*"(user|assistant|system)"/m.test(s)) return true;
    return false;
  };

  const accept = (s0: any) => {
    const s = norm(s0);
    if (!s) return null;
    if (isEmptyLike(s)) return null;
    if (isInternalLike(s)) return null;
    return s;
  };

  // candidates 優先（順序維持）
  if (Array.isArray(args.candidates) && args.candidates.length > 0) {
    for (const c of args.candidates) {
      const s = accept(c);
      if (s) return s;
    }
  }

  const a = accept(args.assistantText);
  if (a) return a;

  const c = accept(args.content);
  if (c) return c;

  const x = accept(args.text);
  if (x) return x;

  return '';
}

export async function maybeAttachRephraseForRenderV2(args: {
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
          (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
          null,
        speechAct: String(pickSpeechAct(meta) ?? '').toUpperCase() || null,
        traceId: traceId ?? null,
        detail: payload,
      });
    } catch (err) {
      console.error('[IROS/rephraseAttach][SKIP][ERROR]', err);
    }
  };

  const attachBlocksFromTextOrSkip = (candidateText: string, attachReason: string) => {
    // ✅ すでに rephraseBlocks / rephraseHead が存在するなら「上書きしない」
    const existingBlocks =
      (extraMerged as any)?.rephraseBlocks ??
      (extraMerged as any)?.rephrase?.blocks ??
      (extraMerged as any)?.rephrase?.rephraseBlocks ??
      (meta as any)?.extra?.rephraseBlocks ??
      (meta as any)?.extra?.rephrase?.blocks ??
      (meta as any)?.extra?.rephrase?.rephraseBlocks ??
      null;

    if (Array.isArray(existingBlocks) && existingBlocks.length > 0) {
      setSkip('ALREADY_HAS_REPHRASE_BLOCKS', { blocksLen: existingBlocks.length, attachReason });
      return false;
    }

    const existingHead =
      String((extraMerged as any)?.rephraseHead ?? '').trim() ||
      String((meta as any)?.extra?.rephraseHead ?? '').trim() ||
      '';

    if (existingHead) {
      setSkip('ALREADY_HAS_REPHRASE_HEAD', { headLen: existingHead.length, attachReason });
      return false;
    }

    const t = String(candidateText ?? '').trim();
    if (!t) {
      setSkip('NO_TEXT_FOR_FALLBACK_BLOCKS', { attachReason });
      return false;
    }

    const fb = buildFallbackRenderBlocksFromFinalText(t);
    if (!Array.isArray(fb) || fb.length === 0) {
      setSkip('FALLBACK_BLOCKS_EMPTY', { attachReason, pickedLen: t.length });
      return false;
    }

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseAttachReason: attachReason,
      rephraseApplied: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: false,
      rephraseReason: meta?.extra?.rephraseReason ?? 'fallback_blocks_from_text',
      rephraseBlocks: fb,
      rephraseHead: (meta?.extra as any)?.rephraseHead ?? t,
    };

    (extraMerged as any).rephraseBlocks = fb;
    (extraMerged as any).rephraseBlocksAttached = true;
    (extraMerged as any).rephraseLLMApplied = false;
    (extraMerged as any).rephraseApplied = false;
    (extraMerged as any).rephraseAttachSkipped = false;
    (extraMerged as any).rephraseAttachReason = attachReason;
    (extraMerged as any).rephraseReason = (extraMerged as any).rephraseReason ?? 'fallback_blocks_from_text';
    (extraMerged as any).rephraseHead = (extraMerged as any).rephraseHead ?? t;

    console.log('[IROS/rephraseAttach][FALLBACK]', {
      conversationId,
      userCode,
      blocksLen: fb.length,
      head: String(fb[0]?.text ?? '').slice(0, 80),
    });

    return true;
  };


  // ---- 1) gate ----
  const enabled = String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
  if (!enabled) {
    setSkip('DISABLED_BY_ENV', { env: 'IROS_REPHRASE_FINAL_ENABLED' });
    return;
  }

  // render-v2 only
  if (extraMerged?.renderEngine !== true) {
    setSkip('RENDER_ENGINE_OFF', { renderEngine: extraMerged?.renderEngine });
    return;
  }

  // ITでも attach を許可するスイッチ（デフォは止める）
  const allowIT = String(process.env.IROS_REPHRASE_ALLOW_IT ?? '0').trim() === '1';

  if (!allowIT && upper(effectiveMode) === 'IT') {
    setSkip('SKIP_BY_EFFECTIVE_MODE_IT', { effectiveMode });

    // ✅ userText は絶対に採用しない（オウム返し事故防止）
    const fallbackText = pickSafeAssistantText({
      candidates: [
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

    attachBlocksFromTextOrSkip(fallbackText, 'FALLBACK_IT_SKIP');
    return;
  }

  const hintedRenderMode =
    (typeof meta?.renderMode === 'string' && meta.renderMode) ||
    (typeof meta?.extra?.renderMode === 'string' && meta.extra.renderMode) ||
    (typeof meta?.extra?.renderedMode === 'string' && meta.extra.renderedMode) ||
    '';

  if (!allowIT && upper(hintedRenderMode) === 'IT') {
    setSkip('SKIP_BY_HINTED_RENDER_MODE_IT', { hintedRenderMode });

    const fallbackText = pickSafeAssistantText({
      candidates: [
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

    attachBlocksFromTextOrSkip(fallbackText, 'FALLBACK_HINTED_IT_SKIP');
    return;
  }

  const speechAct = upper(pickSpeechAct(meta));
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') {
    setSkip('SKIP_BY_SPEECH_ACT', { speechAct });
    return;
  }

  // ---- 2) idempotent ----
  const existingBlocks =
    (extraMerged as any)?.rephraseBlocks ??
    (extraMerged as any)?.rephrase?.blocks ??
    (meta as any)?.extra?.rephraseBlocks ??
    (meta as any)?.extra?.rephrase?.blocks ??
    null;

  if (Array.isArray(existingBlocks) && existingBlocks.length > 0) {
    setSkip('ALREADY_HAS_REPHRASE_BLOCKS', { blocksLen: existingBlocks.length });
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

  // slots が無いなら LLM rephrase はしないが、UIブロックは「assistant側」からのみ付ける
  if (!extracted?.slots?.length) {
    const fallbackText = pickSafeAssistantText({
      candidates: [
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

    attachBlocksFromTextOrSkip(fallbackText, 'FALLBACK_FROM_RESULT_TEXT_NO_SLOTS');

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: true,
      rephraseBlocksAttached: Boolean((extraMerged as any)?.rephraseBlocksAttached ?? false),
      rephraseLLMApplied: false,
      rephraseApplied: false,
      rephraseReason:
        (meta as any)?.extra?.rephraseReason ??
        (extraMerged as any)?.rephraseReason ??
        'no_slots_skip_llm_blocks_attached',
    };

    (extraMerged as any).rephraseAttachSkipped = true;
    (extraMerged as any).rephraseLLMApplied = false;
    (extraMerged as any).rephraseApplied = false;

    return;
  }

  // ---- 4) minimal userContext（直近履歴 + last_state） ----
  const normalizedHistory = normalizeHistoryMessages(historyMessages ?? null);

  const pickStr = (...xs: any[]) => {
    for (const x of xs) {
      const s = String(x ?? '').trim();
      if (s) return s;
    }
    return null;
  };

  const buildFlowDigest = () => {
    const ms = memoryStateForCtx ?? null;

    const depthStage = pickStr(
      ms?.depthStage,
      (meta as any)?.depth_stage,
      (meta as any)?.depthStage,
      (meta as any)?.unified?.depth?.stage,
    );

    const phase = pickStr(ms?.phase, (meta as any)?.phase, (meta as any)?.unified?.phase);

    const layer = pickStr(
      ms?.intentLayer,
      (meta as any)?.intent_layer,
      (meta as any)?.intentLayer,
      (meta as any)?.unified?.intent?.layer,
    );

    const q = pickStr(ms?.qPrimary, (meta as any)?.q_code, (meta as any)?.qCode, (meta as any)?.unified?.q?.current);

    const t = pickStr(ms?.itxStep);
    const anchor = pickStr(ms?.intentAnchor, (meta as any)?.intentAnchor, (meta as any)?.unified?.intent_anchor?.key);

    const saRaw = ms?.selfAcceptance;
    const sa = typeof saRaw === 'number' && Number.isFinite(saRaw) ? String(Math.round(saRaw * 1000) / 1000) : null;

    const parts: string[] = [];
    if (depthStage) parts.push(`depth=${depthStage}`);
    if (phase) parts.push(`phase=${phase}`);
    if (layer) parts.push(`layer=${layer}`);
    if (t) parts.push(`t=${t}`);
    if (anchor) parts.push(`anchor=${anchor}`);
    if (q) parts.push(`q=${q}`);
    if (sa) parts.push(`sa=${sa}`);

    const itxReason = pickStr(ms?.itxReason);
    if (itxReason) parts.push(`itx=${itxReason}`);

    return parts.join(' | ') || null;
  };

  const metaAny: any = meta as any;

  // itx は MemoryState を最優先。無い場合は meta も見る（確実に rephraseEngine に届かせる）
  const itxStepForCtx =
    pickStr(memoryStateForCtx?.itxStep) ||
    pickStr(metaAny?.itx_step) ||
    pickStr(metaAny?.itxStep) ||
    null;

  const itxReasonForCtx =
    pickStr(memoryStateForCtx?.itxReason) ||
    pickStr(metaAny?.itx_reason) ||
    pickStr(metaAny?.itxReason) ||
    null;

  // intentBand は depthStage ではなく「意図帯域」を最優先（例: I2）
  // 無い場合だけ depthStage 等へフォールバック
  const intentBandForCtx =
    pickStr(metaAny?.intentLine?.intentBand) ||
    pickStr(metaAny?.intent_line?.intentBand) ||
    pickStr(metaAny?.intentBand) ||
    pickStr(metaAny?.intent_band) ||
    pickStr(memoryStateForCtx?.intentBand) ||
    pickStr(memoryStateForCtx?.intent_band) ||
    pickStr(memoryStateForCtx?.depthStage) ||
    pickStr(metaAny?.depth_stage) ||
    pickStr(metaAny?.depthStage) ||
    null;

  const tLayerModeActiveForCtx = Boolean(itxStepForCtx && /^T[123]$/u.test(String(itxStepForCtx)));

  const userContext = {
    conversation_id: String(conversationId),

    // 互換（既存）
    last_state: memoryStateForCtx ?? null,
    itxStep: itxStepForCtx,
    itxReason: itxReasonForCtx,
    intentBand: intentBandForCtx,

    flowDigest: buildFlowDigest(),

    // ✅ rephraseHistory が最優先で拾う入口
    turns: normalizedHistory.length ? normalizedHistory : undefined,

    // ✅ rephraseEngine.full.ts 側が読むのは ctxPack.*
    ctxPack: {
      turns: normalizedHistory.length ? normalizedHistory : undefined,
      historyForWriter: normalizedHistory.length ? normalizedHistory : undefined,

      itxStep: itxStepForCtx,
      itxReason: itxReasonForCtx,

      // rephraseEngine の extractIntentBandFromContext が最優先で拾う
      intentBand: intentBandForCtx,

      // tLayerHint / tLayerModeActive も明示（itOk/tLayerHint の確実化）
      tLayerHint: itxStepForCtx,
      tLayerModeActive: tLayerModeActiveForCtx,
    },

    // 互換のため残す
    historyMessages: normalizedHistory.length ? normalizedHistory : undefined,
  };


  // ---- 5) call LLM ----
  const model = process.env.IROS_REPHRASE_MODEL ?? process.env.IROS_MODEL ?? 'gpt-4.1';

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

  const inputKindForLLM = String(
    (meta as any)?.framePlan?.inputKind ?? (meta as any)?.inputKind ?? (userContext as any)?.framePlan?.inputKind ?? '',
  ).toLowerCase();
  console.log('[IROS/_impl/rephrase.ts][USERCTX_KEYS]', {
    hasTurns: Array.isArray((userContext as any)?.turns),
    turnsLen: Array.isArray((userContext as any)?.turns) ? (userContext as any).turns.length : 0,
    hasCtxPack: !!(userContext as any)?.ctxPack,
    ctxPackKeys: (userContext as any)?.ctxPack ? Object.keys((userContext as any).ctxPack) : [],
    conversationId,
    userCode,
  });

  // =========================================================
  // 診断 FINAL(IR) は LLM rephrase を呼ばない（崩れ防止）
  // ただしブロック化は「assistant側テキストのみ」から行う
  // =========================================================
  const modeNow = String(effectiveMode ?? '').toLowerCase();
  const presentationKindNow = String((extraMerged as any)?.presentationKind ?? '').toLowerCase();
  const slotPlanPolicyNow = String(
    (extraMerged as any)?.slotPlanPolicy ??
      (meta as any)?.framePlan?.slotPlanPolicy ??
      (meta as any)?.slotPlanPolicy ??
      '',
  ).toUpperCase();

  const isDiagnosisTurn =
    modeNow === 'diagnosis' || presentationKindNow === 'diagnosis' || Boolean((extraMerged as any)?.isIrDiagnosisTurn);

  const allowDiagnosisFinalRephrase = (() => {
    const v = String(process.env.IROS_REPHRASE_ALLOW_DIAGNOSIS_FINAL ?? '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled';
  })();

  const shouldSkipRephraseLLMForDiagnosisFinal =
    isDiagnosisTurn && slotPlanPolicyNow === 'FINAL' && !allowDiagnosisFinalRephrase;

  if (shouldSkipRephraseLLMForDiagnosisFinal) {
    const finalText = pickSafeAssistantText({
      candidates: [
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
      ],
    });

    attachBlocksFromTextOrSkip(finalText, 'DIAGNOSIS_FINAL_SEED_ONLY');

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: true,
      rephraseBlocksAttached: Boolean((extraMerged as any)?.rephraseBlocksAttached ?? false),
      rephraseLLMApplied: false,
      rephraseApplied: false,
      rephraseReason: 'diagnosis_final_seed_only',
    };

    (extraMerged as any).rephraseAttachSkipped = true;
    return;
  }

  // =========================================================
  // 通常: rephraseSlotsFinal を呼ぶ
  // =========================================================
  try {
    const res = await rephraseSlotsFinal(extracted, {
      model,
      conversationId,
      userCode,
      traceId,
      userText,
      qCode: qCodeForLLM,
      depthStage: depthForLLM,
      inputKind: inputKindForLLM,
      userContext,
    } as any);

    console.log('[IROS/rephraseAttach][RES_KEYS]', {
      resKeys: Object.keys(res ?? {}),
      metaKeys: Object.keys((res as any)?.meta ?? {}),
      outKeys: Object.keys((res as any)?.out ?? {}),
      metaOutKeys: Object.keys((res as any)?.meta?.out ?? {}),
    });

    // ✅ rephraseSlotsFinal の正本は res.meta.extra（AFTER_ATTACH）側
    const resExtra =
      (res as any)?.meta?.extra ??
      (res as any)?.metaForSave?.extra ??
      (res as any)?.extra ??
      null;

    // ✅ blocks が空でも head だけは先に反映しておく（fallbackで user seed を拾わせない）
    const resHead = String((resExtra as any)?.rephraseHead ?? '').trim();
    if (resHead) {
      (extraMerged as any).rephraseHead = String((extraMerged as any).rephraseHead ?? '').trim() || resHead;
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseHead: String((meta as any)?.extra?.rephraseHead ?? '').trim() || resHead,
      };
    }

    // ✅ blocks 探索：res.meta.extra（正本）→ meta/out 互換 → 直下互換
    const blocksAny =
      (resExtra as any)?.rephraseBlocks ??
      (resExtra as any)?.rephrase?.blocks ??
      (res as any)?.meta?.extra?.rephraseBlocks ??
      (res as any)?.meta?.extra?.rephrase?.blocks ??
      (res as any)?.meta?.rephraseBlocks ??
      (res as any)?.meta?.out?.blocks ??
      (res as any)?.meta?.out?.rephraseBlocks ??
      (res as any)?.blocks ??
      (res as any)?.rephraseBlocks ??
      (res as any)?.out?.blocks ??
      (res as any)?.out?.rephraseBlocks ??
      null;


    const blocks: any[] | null = Array.isArray(blocksAny) ? blocksAny : null;

    if (!blocks || blocks.length === 0) {
      // ✅ userText に逃げない。assistant側から拾えなければ SKIP
      const fallbackText = pickSafeAssistantText({
        candidates: [
          (extraMerged as any)?.rephraseHead,
          (meta as any)?.extra?.rephraseHead,
          (extraMerged as any)?.finalAssistantTextCandidate,
          (extraMerged as any)?.finalAssistantText,
          (extraMerged as any)?.assistantText,
          (extraMerged as any)?.resolvedText,
          (extraMerged as any)?.extractedTextFromModel,
          (extraMerged as any)?.rawTextFromModel,
          (extraMerged as any)?.content,
          (extraMerged as any)?.text,
        ],
      });

      attachBlocksFromTextOrSkip(fallbackText, 'REPHRASE_EMPTY_FALLBACK');
      return;
    }


    (extraMerged as any).rephraseBlocks = blocks;
    (extraMerged as any).rephraseBlocksAttached = true;
    (extraMerged as any).rephraseLLMApplied = true;
    (extraMerged as any).rephraseApplied = true;
    (extraMerged as any).rephraseReason = (extraMerged as any).rephraseReason ?? 'rephrase_slots_final';
    (extraMerged as any).rephraseHead =
      (extraMerged as any).rephraseHead ?? String((blocks?.[0] as any)?.text ?? '').trim();

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: true,
      rephraseApplied: true,
      rephraseReason: (meta as any)?.extra?.rephraseReason ?? 'rephrase_slots_final',
      rephraseHead: (meta as any)?.extra?.rephraseHead ?? String((blocks?.[0] as any)?.text ?? '').trim(),
    };

    console.log('[IROS/rephraseAttach][OK]', {
      conversationId,
      userCode,
      blocksLen: blocks.length,
      head: String((blocks?.[0] as any)?.text ?? '').slice(0, 120),
    });
  } catch (e: any) {
    console.error('[IROS/rephraseAttach][EXCEPTION]', {
      conversationId,
      userCode,
      err: String(e?.message ?? e),
    });

    const fallbackText = pickSafeAssistantText({
      candidates: [
        (extraMerged as any)?.finalAssistantTextCandidate,
        (extraMerged as any)?.finalAssistantText,
        (extraMerged as any)?.assistantText,
        (extraMerged as any)?.resolvedText,
        (extraMerged as any)?.extractedTextFromModel,
        (extraMerged as any)?.rawTextFromModel,
        (extraMerged as any)?.content,
        (extraMerged as any)?.text,
        (extraMerged as any)?.rephraseHead,
        (meta as any)?.extra?.rephraseHead,
      ],
    });

    attachBlocksFromTextOrSkip(fallbackText, 'REPHRASE_EXCEPTION_FALLBACK');
  }
}
