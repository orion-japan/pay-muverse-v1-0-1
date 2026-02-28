// src/app/api/agent/iros/reply/_impl/rephrase.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { pickSpeechAct } from '../_helpers';
import { extractSlotsForRephrase, rephraseSlotsFinal } from '@/lib/iros/language/rephraseEngine';

type RenderBlock = { text: string | null | undefined; kind?: string };

type NormTurn = { role: 'user' | 'assistant'; content: string };

const UPPER = (v: any) => String(v ?? '').trim().toUpperCase();
const TRIM = (v: any) => String(v ?? '').trim();

function normalizeHistoryMessages(raw: unknown[] | string | null | undefined): NormTurn[] {
  if (!raw) return [];
  if (typeof raw === 'string') return [];
  if (!Array.isArray(raw)) return [];

  const out: NormTurn[] = [];

  // UI から来る history は形がブレるので “受け口” を広くしつつ、最後は規格化する
  for (const m of raw.slice(-24)) {
    if (!m || typeof m !== 'object') continue;

    const roleRaw = String((m as any)?.role ?? (m as any)?.speaker ?? (m as any)?.type ?? '')
      .toLowerCase()
      .trim();

    const body = String((m as any)?.content ?? (m as any)?.text ?? (m as any)?.message ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

    if (!body) continue;

    const isAssistant =
      roleRaw === 'assistant' || roleRaw === 'bot' || roleRaw === 'system' || roleRaw.startsWith('a');

    out.push({
      role: isAssistant ? 'assistant' : 'user',
      content: body,
    });
  }

  // writer に渡すのは薄く（直近だけ）
  return out.slice(-12);
}

function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = TRIM(finalText);
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

  // 1) [[ILINE]]...[[/ILINE]] が先頭にあるなら、そこは先頭ブロックとして固定
  const start = t.indexOf('[[ILINE]]');
  const end = t.indexOf('[[/ILINE]]');
  let rest = t;

  if (start === 0 && end > start) {
    const ilineBlock = t.slice(0, end + '[[/ILINE]]'.length).trim();
    if (ilineBlock) blocksText.push(ilineBlock);
    rest = t.slice(end + '[[/ILINE]]'.length).trim();
  }

  // 2) 残りを段落/行でブロック化
  for (const b of splitToBlocks(rest)) blocksText.push(b);

  return blocksText.map((text) => ({ text, kind: 'p' }));
}

/**
 * userText を「絶対に本文候補にしない」安全版 picker
 * - EMPTY_LIKE（…… / ...）は捨てる
 * - @OBS/@SHIFT 等の内部マーカーは捨てる
 */
function pickSafeAssistantText(args: {
  assistantText?: string | null;
  content?: string | null;
  text?: string | null;
  candidates?: any[];
}): string {
  const norm = (v: any) =>
    String(v ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();

  const isEmptyLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return true;
    if (/^[.。・…]{2,}$/u.test(s)) return true;
    if (/^…+$/.test(s)) return true;
    return false;
  };

  const isInternalLike = (s0: string) => {
    const s = norm(s0);
    if (!s) return false;
    if (/(^|\n)\s*@(OBS|SHIFT|NEXT|SAFE|DRAFT|SEED_TEXT)\b/m.test(s)) return true;
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

function pickStr(...xs: any[]): string | null {
  for (const x of xs) {
    const s = TRIM(x);
    if (s) return s;
  }
  return null;
}

function envBool(name: string, defaultOn = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes' || raw === 'enabled';
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
  effectiveMode?: string | null; // route で確定した最終 mode
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
        speechAct: UPPER(pickSpeechAct(meta) ?? '') || null,
        traceId: traceId ?? null,
        detail: payload,
      });
    } catch (err) {
      console.error('[IROS/rephraseAttach][SKIP][ERROR]', err);
    }
  };

  const attachBlocksFromTextOrSkip = (candidateText: string, attachReason: string) => {
    // ✅ existing blocks/head が「ゴミ」なら温存せず破棄して作り直す（短文ループ回避）
    const isGarbageText = (s: any) => {
      const t = TRIM(String(s ?? ''));
      if (!t) return true;

      // 短すぎはゴミ扱い（例：「続けてください」「……」）
      if (t.length <= 12) return true;

      // 記号・点々だけ
      if (/^[\s…。．.、,!！?？]+$/.test(t)) return true;

      // 典型の短文ループ
      if (/^(続けて(ください)?|続けよう|続けてね)[\s。．.!！?？]*$/.test(t)) return true;

      return false;
    };

    const clearExistingRephrase = (why: string, detail?: any) => {
      try {
        // extraMerged 側
        delete (extraMerged as any).rephraseBlocks;
        delete (extraMerged as any).rephraseHead;
        delete (extraMerged as any).rephrase;
        delete (extraMerged as any).rephraseBlocksAttached;

        // meta.extra 側（存在するなら）
        if (meta?.extra && typeof meta.extra === 'object') {
          delete (meta.extra as any).rephraseBlocks;
          delete (meta.extra as any).rephraseHead;
          delete (meta.extra as any).rephrase;
          delete (meta.extra as any).rephraseBlocksAttached;
        }

        console.warn('[IROS/rephraseAttach][OVERRIDE]', {
          conversationId,
          userCode,
          why,
          attachReason,
          ...(detail ?? {}),
        });
      } catch (e) {
        console.error('[IROS/rephraseAttach][OVERRIDE][ERROR]', e);
      }
    };

    // ✅ すでに rephraseBlocks / rephraseHead が存在するなら上書きしない
    //    ただし「ゴミ」なら破棄して作り直す
    const existingBlocks =
      (extraMerged as any)?.rephraseBlocks ??
      (extraMerged as any)?.rephrase?.blocks ??
      (extraMerged as any)?.rephrase?.rephraseBlocks ??
      (meta as any)?.extra?.rephraseBlocks ??
      (meta as any)?.extra?.rephrase?.blocks ??
      (meta as any)?.extra?.rephrase?.rephraseBlocks ??
      null;

    if (Array.isArray(existingBlocks) && existingBlocks.length > 0) {
      const headText =
        TRIM(
          String(
            (typeof existingBlocks[0] === 'string'
              ? existingBlocks[0]
              : (existingBlocks[0] as any)?.text) ?? ''
          )
        ) || '';

      const garbage = existingBlocks.length === 1 && isGarbageText(headText);

      if (!garbage) {
        setSkip('ALREADY_HAS_REPHRASE_BLOCKS', { blocksLen: existingBlocks.length, attachReason });
        return false;
      }

      // ✅ ゴミなら捨てて、通常フローで fallback blocks を作り直す
      clearExistingRephrase('GARBAGE_EXISTING_BLOCKS', {
        blocksLen: existingBlocks.length,
        head: headText.slice(0, 80),
      });
    }

    const existingHead =
      TRIM((extraMerged as any)?.rephraseHead) || TRIM((meta as any)?.extra?.rephraseHead) || '';

    if (existingHead) {
      const garbage = isGarbageText(existingHead);

      if (!garbage) {
        setSkip('ALREADY_HAS_REPHRASE_HEAD', { headLen: existingHead.length, attachReason });
        return false;
      }

      // ✅ ゴミなら捨てて作り直す
      clearExistingRephrase('GARBAGE_EXISTING_HEAD', {
        head: String(existingHead).slice(0, 80),
        headLen: existingHead.length,
      });
    }

    const t = TRIM(candidateText);
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
    (extraMerged as any).rephraseReason =
      (extraMerged as any).rephraseReason ?? 'fallback_blocks_from_text';
    (extraMerged as any).rephraseHead = (extraMerged as any).rephraseHead ?? t;

    console.log('[IROS/rephraseAttach][FALLBACK]', {
      conversationId,
      userCode,
      attachReason,
      blocksLen: fb.length,
      head: String(fb[0]?.text ?? '').slice(0, 80),
      pickedLen: t.length,
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

  // IT でも attach を許可するスイッチ（デフォ OFF）
  const allowIT = envBool('IROS_REPHRASE_ALLOW_IT', false);

  if (!allowIT && UPPER(effectiveMode) === 'IT') {
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

  if (!allowIT && UPPER(hintedRenderMode) === 'IT') {
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

  // NOTE: route 側では SILENCE を廃止して FORWARD のみに寄せているが、
  // 互換のためここでは SILENCE/FORWARD の両方を “attach skip” として扱う
  const speechAct = UPPER(pickSpeechAct(meta));
  if (speechAct === 'SILENCE' || speechAct === 'FORWARD') {
    setSkip('SKIP_BY_SPEECH_ACT', { speechAct });
    return;
  }

  // ---- 2) idempotent ----
  {
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
  }

  // ---- 3) slots ----
  const extraForRender = {
    ...(meta?.extra ?? {}),
    ...(extraMerged ?? {}),

    // ✅ postprocess で検出した policy を拾う（framePlan が欠けるケースの救済）
    slotPlanPolicy:
      (meta as any)?.framePlan?.slotPlanPolicy ??
      (meta as any)?.slotPlanPolicy ??
      (meta as any)?.extra?.slotPlanPolicy ??
      (meta as any)?.extra?.slotPlanPolicy_detected ??
      null,

    framePlan: (meta as any)?.framePlan ?? null,
    slotPlan: (meta as any)?.slotPlan ?? null,

    // ✅ seed の互換注入：extractSlotsForRephrase が slotPlanSeed/slotSeed を見ても落ちないようにする
    slotPlanSeed:
      TRIM((meta as any)?.extra?.slotPlanSeed) ||
      TRIM((extraMerged as any)?.slotPlanSeed) ||
      TRIM((meta as any)?.extra?.llmRewriteSeed) ||
      TRIM((extraMerged as any)?.llmRewriteSeed) ||
      null,

    slotSeed:
      TRIM((meta as any)?.extra?.slotSeed) ||
      TRIM((extraMerged as any)?.slotSeed) ||
      TRIM((meta as any)?.extra?.llmRewriteSeed) ||
      TRIM((extraMerged as any)?.llmRewriteSeed) ||
      null,
  };


  const extracted = extractSlotsForRephrase(extraForRender);

  // slots が無いなら LLM rephrase はしないが、UI ブロックは assistant 側テキストのみから付ける
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

  const buildFlowDigest = () => {
    // 1) “流れ”の要約（tape/digest 由来）を最優先
    const metaAnyLocal: any = meta as any;

    const carriedFlowDigest = pickStr(
      metaAnyLocal?.extra?.flowDigest,
      metaAnyLocal?.extra?.flow_digest,
      metaAnyLocal?.framePlan?.extra?.flowDigest,
      metaAnyLocal?.framePlan?.extra?.flow_digest,
      metaAnyLocal?.ctxPack?.flow?.digest,
      metaAnyLocal?.ctx_pack?.flow?.digest,
      metaAnyLocal?.orch?.flowDigest,
      metaAnyLocal?.orch?.flow_digest,
    );

    if (carriedFlowDigest) return carriedFlowDigest;

    // 2) fallback：状態ダイジェスト
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

  // itx は MemoryState を最優先。無い場合は meta も見る（writer に確実に届かせる）
  const itxStepForCtx = pickStr(memoryStateForCtx?.itxStep, metaAny?.itx_step, metaAny?.itxStep);
  const itxReasonForCtx = pickStr(memoryStateForCtx?.itxReason, metaAny?.itx_reason, metaAny?.itxReason);

// intentBand は「会話の今フレーム（depthStage）」を最優先。
// meta.intentLine.intentBand は補助（CフレームでI帯に引っ張られる事故を防ぐ）
const intentBandForCtx =
  pickStr(memoryStateForCtx?.depthStage) ||
  pickStr(metaAny?.depth_stage) ||
  pickStr(metaAny?.depthStage) ||
  pickStr(metaAny?.unified?.depth?.stage) ||
  pickStr(metaAny?.intentLine?.intentBand) ||
  pickStr(metaAny?.intent_line?.intentBand) ||
  pickStr(metaAny?.intentBand) ||
  pickStr(metaAny?.intent_band) ||
  pickStr(memoryStateForCtx?.intentBand) ||
  pickStr(memoryStateForCtx?.intent_band) ||
  null;


  const tLayerHintForCtx = itxStepForCtx; // ctxPack へ渡す T層ヒント（互換）
  const tLayerModeActiveForCtx = Boolean(itxStepForCtx && /^T[123]$/u.test(String(itxStepForCtx)));

  // 返信の目的（結論ではなく “守るべき姿勢”）
  const buildReplyGoal = () => {
    if (tLayerModeActiveForCtx) return 'permit_density';

    // 反復（同じ文の言い直し）っぽいときは散らかり抑制
    const turns = normalizedHistory ?? [];
    const userTurns = turns.filter((m: any) => String(m?.role ?? '') === 'user');
    const last2 = userTurns
      .slice(-2)
      .map((m: any) => String(m?.content ?? '').trim())
      .filter(Boolean);

    if (last2.length === 2 && last2[0] === last2[1]) return 'reduce_scatter';
    return 'reflect_position';
  };

  const replyGoalForCtx = buildReplyGoal();
  // repeatSignal（反復シグナル）は upstream があれば拾う。無ければ null のまま。
  const repeatSignalForCtx: string | null = (() => {
    const pick = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (!s) continue;
        return s;
      }
      return null;
    };

    return pick(
      (extraMerged as any)?.repeatSignal,
      (extraMerged as any)?.extra?.repeatSignal,
      (extraMerged as any)?.ctxPack?.repeatSignal,
      (extraMerged as any)?.extra?.ctxPack?.repeatSignal,
      (meta as any)?.extra?.repeatSignal,
      (meta as any)?.extra?.ctxPack?.repeatSignal,
      (meta as any)?.ctxPack?.repeatSignal,
      (meta as any)?.framePlan?.ctxPack?.repeatSignal,
      (meta as any)?.framePlan?.extra?.ctxPack?.repeatSignal
    );
  })();
  // 3点セット（会話を散らさない）
  const topicDigestForCtx: string | null = (() => {
    const pick = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (!s) continue;
        return s;
      }
      return null;
    };

    // 1) まずは upstream にある “正本” を最優先で拾う
    const upstream = pick(
      (extraMerged as any)?.topicDigest,
      (extraMerged as any)?.extra?.topicDigest,

      (extraMerged as any)?.ctxPack?.topicDigest,
      (extraMerged as any)?.ctxPack?.conversationLine,
      (extraMerged as any)?.extra?.ctxPack?.topicDigest,
      (extraMerged as any)?.extra?.ctxPack?.conversationLine,

      (meta as any)?.extra?.topicDigest,
      (meta as any)?.extra?.ctxPack?.topicDigest,
      (meta as any)?.extra?.ctxPack?.conversationLine,
      (meta as any)?.ctxPack?.topicDigest,
      (meta as any)?.ctxPack?.conversationLine,

      (meta as any)?.framePlan?.ctxPack?.topicDigest,
      (meta as any)?.framePlan?.ctxPack?.conversationLine,
      (meta as any)?.framePlan?.extra?.ctxPack?.topicDigest,
      (meta as any)?.framePlan?.extra?.ctxPack?.conversationLine
    );
    if (upstream) return upstream;

    // 2) 無ければ MemoryState の situationSummary を拾う（userText ではない安全な救済）
    const msSummary = pick((memoryStateForCtx as any)?.situationSummary);
    if (msSummary) return msSummary;

    // 3) それでも無ければ history から“軽い1行”を救済生成する
    const hist: any[] = Array.isArray(normalizedHistory) ? normalizedHistory : [];
    const lastUsers = hist
      .filter((m: any) => m && m.role === 'user')
      .map((m: any) => String(m.content ?? '').trim())
      .filter((s: string) => s.length > 0)
      .slice(-3);

    if (lastUsers.length === 0) return null;

    const cleaned = lastUsers.map((s) =>
      s
        .replace(/\s+/g, ' ')
        .replace(/[。.!！?？]+$/g, '')
        .trim()
    );

    // 同文連投は畳む
    const uniq = cleaned.filter((s, i, arr) => i === 0 || s !== arr[i - 1]);

    // 直近3件を短く連結（長すぎる時は切る）
    const joined = uniq.join('・').trim();
    return joined ? joined.slice(0, 40) : null;
  })();

  // conversationLine を “確実に” 用意する（rephraseEngine 側フォールバックを効かせる）
  const conversationLineForCtx: string | null = (() => {
    const pick = (...cands: any[]) => {
      for (const v of cands) {
        if (v === undefined || v === null) continue;
        const s = String(v).trim();
        if (!s) continue;
        return s;
      }
      return null;
    };
    return pick(
      (extraMerged as any)?.ctxPack?.conversationLine,
      (extraMerged as any)?.extra?.ctxPack?.conversationLine,
      (meta as any)?.extra?.ctxPack?.conversationLine,
      (meta as any)?.ctxPack?.conversationLine,
      (meta as any)?.framePlan?.ctxPack?.conversationLine,
      topicDigestForCtx
    );
  })();
  // =========================================================
  // ctxPack / slotPlanPolicy を “確実に” 定義（不足分だけ補完する前提）
  // - upstream を最優先で継承
  // - 無ければ空オブジェクトから開始
  // =========================================================

  // slotPlanPolicy を確実に通す
  const slotPlanPolicyForCtx =
    String(
      (extraMerged as any)?.slotPlanPolicy ??
        (extraMerged as any)?.extra?.slotPlanPolicy ??
        (extraMerged as any)?.ctxPack?.slotPlanPolicy ??
        (extraMerged as any)?.extra?.ctxPack?.slotPlanPolicy ??
        (meta as any)?.framePlan?.slotPlanPolicy ??
        (meta as any)?.slotPlanPolicy ??
        ''
    )
      .toUpperCase()
      .trim() || null;

  // handleIrosReply / renderEngine 側で stamp 済みの ctxPack を最優先で継承
  const ctxPackFromUpstream =
    // 1) route.ts / renderEngine 側で extraMerged に載せてきたもの（最優先）
    (extraMerged as any)?.ctxPack ??
    (extraMerged as any)?.extra?.ctxPack ??

    // 2) meta.extra に stamp 済み
    (meta as any)?.extra?.ctxPack ??

    // 3) meta 直下や framePlan 経由（handleIrosReply/orchestrator 側で載る可能性）
    (meta as any)?.ctxPack ??
    (meta as any)?.framePlan?.ctxPack ??
    (meta as any)?.framePlan?.extra?.ctxPack ??

    // 4) 互換（ctx_pack / ctxPack under extra）
    (meta as any)?.extra?.ctx_pack ??
    (meta as any)?.ctx_pack ??
    null;

  const ctxPack: any =
    ctxPackFromUpstream && typeof ctxPackFromUpstream === 'object'
      ? { ...(ctxPackFromUpstream as any) }
      : {};

  // ✅ blank 判定（null/undefined/空文字/空白文字/ kind:'' を “空” とみなす）
  const isBlankLike = (v: any) => {
    if (v === null || v === undefined) return true;
    if (typeof v === 'string') return v.trim().length === 0;
    if (typeof v === 'object') {
      const k = (v as any)?.kind;
      if (typeof k === 'string' && k.trim().length === 0) return true;
    }
    return false;
  };

  if (isBlankLike((ctxPack as any).replyGoal)) (ctxPack as any).replyGoal = replyGoalForCtx;

  // upstream を尊重しつつ、不足分だけ補完
  if (ctxPack.turns == null) ctxPack.turns = normalizedHistory.length ? normalizedHistory : undefined;
  if (ctxPack.historyForWriter == null) ctxPack.historyForWriter = normalizedHistory.length ? normalizedHistory : undefined;
  if (isBlankLike(ctxPack.slotPlanPolicy)) ctxPack.slotPlanPolicy = slotPlanPolicyForCtx;

  if (isBlankLike(ctxPack.itxStep)) ctxPack.itxStep = itxStepForCtx;
  if (isBlankLike(ctxPack.itxReason)) ctxPack.itxReason = itxReasonForCtx;
  if (isBlankLike(ctxPack.intentBand)) ctxPack.intentBand = intentBandForCtx;

  if (ctxPack.tLayerHint == null) ctxPack.tLayerHint = tLayerHintForCtx ?? null;
  if (ctxPack.tLayerModeActive == null) ctxPack.tLayerModeActive = tLayerModeActiveForCtx;

  // ★3点セット（空文字でも補完する）
  if (isBlankLike(ctxPack.topicDigest)) ctxPack.topicDigest = topicDigestForCtx;
  if (isBlankLike(ctxPack.conversationLine)) ctxPack.conversationLine = conversationLineForCtx; // ✅ 追加
  if (isBlankLike(ctxPack.replyGoal)) ctxPack.replyGoal = replyGoalForCtx;
  if (isBlankLike(ctxPack.repeatSignal)) ctxPack.repeatSignal = repeatSignalForCtx;

  // phase / depthStage / qCode を ctxPack にも載せるための “確証つき” 値
  const phaseForCtx =
    (memoryStateForCtx as any)?.phase ??
    (meta as any)?.phase ??
    (meta as any)?.extra?.phase ??
    null;

  const qCodeForCtx =
    (typeof (meta as any)?.q_code === 'string' && TRIM((meta as any).q_code)) ||
    (typeof (meta as any)?.qCode === 'string' && TRIM((meta as any).qCode)) ||
    (typeof (meta as any)?.qPrimary === 'string' && TRIM((meta as any).qPrimary)) ||
    (typeof (meta as any)?.unified?.q?.current === 'string' && TRIM((meta as any).unified.q.current)) ||
    null;

  const depthForCtx =
    (typeof (meta as any)?.depth_stage === 'string' && TRIM((meta as any).depth_stage)) ||
    (typeof (meta as any)?.depthStage === 'string' && TRIM((meta as any).depthStage)) ||
    (typeof (meta as any)?.depth === 'string' && TRIM((meta as any).depth)) ||
    (typeof (meta as any)?.unified?.depth?.stage === 'string' && TRIM((meta as any).unified.depth.stage)) ||
    null;

  // ★ここが本丸：rephraseEngine が拾う “3点セット” を ctxPack にも載せる
  if (isBlankLike(ctxPack.phase)) ctxPack.phase = phaseForCtx;
  if (isBlankLike(ctxPack.depthStage)) ctxPack.depthStage = depthForCtx;
  if (isBlankLike(ctxPack.qCode)) ctxPack.qCode = qCodeForCtx;

  // flowDigest は既存 util を使う（upstream の flow があれば触らない）
  if (ctxPack.flowDigest == null) ctxPack.flowDigest = buildFlowDigest();

  const userContext: any = {
    conversation_id: String(conversationId),

    // policy
    slotPlanPolicy: slotPlanPolicyForCtx,

    // 3点セット
    topicDigest: topicDigestForCtx,
    replyGoal: replyGoalForCtx,
    repeatSignal: repeatSignalForCtx,

    // 互換
    last_state: memoryStateForCtx ?? null,
    itxStep: itxStepForCtx,
    itxReason: itxReasonForCtx,
    intentBand: intentBandForCtx,

    flowDigest: buildFlowDigest(),

    turns: normalizedHistory.length ? normalizedHistory : undefined,

    // ✅ 継承＋補完済みの ctxPack を使う（上書き生成しない）
    ctxPack,

    historyMessages: normalizedHistory.length ? normalizedHistory : undefined,
  };
  // =========================================================
  // 診断 FINAL(IR) は LLM rephrase を呼ばない（崩れ防止）
  // ただしブロック化は assistant 側テキストのみから行う
  // =========================================================
  const modeNow = String(effectiveMode ?? '').toLowerCase();
  const presentationKindNow = String((extraMerged as any)?.presentationKind ?? '').toLowerCase();
  const slotPlanPolicyNow = slotPlanPolicyForCtx;

  const isDiagnosisTurn =
    modeNow === 'diagnosis' || presentationKindNow === 'diagnosis' || Boolean((extraMerged as any)?.isIrDiagnosisTurn);

  const allowDiagnosisFinalRephrase = envBool('IROS_REPHRASE_ALLOW_DIAGNOSIS_FINAL', false);

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

// ---- 5) call LLM ----
const model = process.env.IROS_REPHRASE_MODEL ?? process.env.IROS_MODEL ?? 'gpt-5';

function TRIM(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

const qCodeForLLM =
  (typeof (meta as any)?.q_code === 'string' && TRIM((meta as any).q_code)) ||
  (typeof (meta as any)?.qCode === 'string' && TRIM((meta as any).qCode)) ||
  (typeof (meta as any)?.qPrimary === 'string' && TRIM((meta as any).qPrimary)) ||
  (typeof (meta as any)?.unified?.q?.current === 'string' && TRIM((meta as any).unified.q.current)) ||
  null;

const depthForLLM =
  (typeof (meta as any)?.depth_stage === 'string' && TRIM((meta as any).depth_stage)) ||
  (typeof (meta as any)?.depthStage === 'string' && TRIM((meta as any).depthStage)) ||
  (typeof (meta as any)?.depth === 'string' && TRIM((meta as any).depth)) ||
  (typeof (meta as any)?.unified?.depth?.stage === 'string' && TRIM((meta as any).unified.depth.stage)) ||
  null;

  // inputKind
  // - 明示スタンプ（meta / framePlan / userContext）をまず拾う
  // - ただし stamped='chat' は “デフォルト” 扱いにして、カード要求があれば card を優先する
  const inputKindStampedRaw =
    (meta as any)?.framePlan?.inputKind ??
    (meta as any)?.inputKind ??
    (userContext as any)?.framePlan?.inputKind ??
    '';

  const inputKindStamped = String(inputKindStampedRaw).trim().toLowerCase();

// ✅ 厳しめ：カード要求（「カード」+「引く/引いて/ひく/引き直す」系）が同時にある時だけ
// const wantsCardByText = (() => { ... })();

  // ✅ カード要求判定
  // - 初回は「カード|card」必須
  // - 追加は「引く/引いて」だけでもOKだが、直近にカード文脈がある場合に限定
  const wantsCardByText = (() => {
    const t = String(userText ?? '').trim();
    if (!t) return false;

    const hasDrawWord =
      /引(?:い|き|く|け)|ひ(?:い|き|く|け)|引き直|引きなお|引き直し|引きなおし|引き直して|引きなおして/.test(t);
    if (!hasDrawWord) return false;

    const hasCardWord = /カード|card/i.test(t);
    if (hasCardWord) return true; // ✅ 初回起動OK

    // ✅ ここから先は「追加」判定：カード文脈が直近にある時だけ許可
    const lastAssistantText = (() => {
      try {
        const hfw: any[] =
          (userContext as any)?.ctxPack?.historyForWriter ??
          (userContext as any)?.historyForWriter ??
          (userContext as any)?.turnsForWriter ??
          [];
        if (!Array.isArray(hfw) || hfw.length === 0) return '';
        for (let i = hfw.length - 1; i >= 0; i--) {
          if (hfw[i]?.role === 'assistant') return String(hfw[i]?.content ?? '').trim();
        }
        return '';
      } catch {
        return '';
      }
    })();

    const hasCardContext =
      /カード|card/i.test(lastAssistantText) ||
      /引くね|引いてみる|引いてみよう|引いてみて|カードを引/i.test(lastAssistantText);

    return hasCardContext;
  })();

  // stamped が空/不明 → 推定へ
  // stamped が 'chat' はデフォルト扱いで wantsCardByText があれば card を優先
  // stamped が 'micro'/'greeting' も “デフォルト扱い” にして、カード要求があれば card に上書き（ここが重要）
  // stamped が 'card' 等 → そのまま尊重（明示指定）
  const inputKindForLLM = (() => {
    if (!inputKindStamped) return wantsCardByText ? 'card' : '';

    if (inputKindStamped === 'chat') return wantsCardByText ? 'card' : 'chat';

    if (inputKindStamped === 'micro' || inputKindStamped === 'greeting') {
      return wantsCardByText ? 'card' : inputKindStamped;
    }

    return inputKindStamped;
  })();

  console.log('[IROS/_impl/rephrase.ts][INPUT_KIND_DIAG]', {
    inputKindStampedRaw,
    inputKindStamped,
    wantsCardByText,
    inputKindForLLM,
    userTextHead: String(userText ?? '').slice(0, 40),
  });

  console.log('[IROS/_impl/rephrase.ts][INPUT_KIND_DIAG]', {
    inputKindStampedRaw,
    inputKindStamped,
    wantsCardByText,
    inputKindForLLM,
    userTextHead: String(userText ?? '').slice(0, 40),
  });

// ctxPack.historyDigestV1 を “最終注入”（hasDigest を true にする）
// + historyForWriter が空なら ctxPack.turns から救済して turnsForWriter を作る（user生文は伏せる）
try {
  if (!userContext.ctxPack || typeof userContext.ctxPack !== 'object') userContext.ctxPack = {};

  // ---- digestV1 ----
  if ((userContext.ctxPack as any).historyDigestV1 == null) {
    const digestV1 =
      (meta as any)?.extra?.historyDigestV1 ??
      (meta as any)?.extra?.ctxPack?.historyDigestV1 ??
      (extraMerged as any)?.historyDigestV1 ??
      (extraMerged as any)?.ctxPack?.historyDigestV1 ??
      (typeof buildFlowDigest === 'function' ? buildFlowDigest() : null) ??
      null;

    if (digestV1) (userContext.ctxPack as any).historyDigestV1 = digestV1;
  }

  // ---- historyForWriter -> turnsForWriter（userは伏せる）----
  // 1) まず “正本候補” を拾う
  const hfwRaw =
    (meta as any)?.extra?.historyForWriter ??
    (meta as any)?.extra?.ctxPack?.historyForWriter ??
    (extraMerged as any)?.historyForWriter ??
    (extraMerged as any)?.ctxPack?.historyForWriter ??
    (userContext as any)?.historyForWriter ??
    (userContext as any)?.ctxPack?.historyForWriter ??
    null;

  const curHfw = (userContext.ctxPack as any).historyForWriter;
  const curLen = Array.isArray(curHfw) ? curHfw.length : 0;

  // 2) もし historyForWriter が空なら ctxPack.turns から “互換形” を作る
  //    - assistant は本文OK / user は伏せる（役割だけ残す）
  const turnsRaw =
    (userContext as any)?.ctxPack?.turns ??
    (meta as any)?.extra?.ctxPack?.turns ??
    (extraMerged as any)?.ctxPack?.turns ??
    null;

  let hfwFromTurns: any[] | null = null;
  if ((!Array.isArray(hfwRaw) || hfwRaw.length === 0) && Array.isArray(turnsRaw) && turnsRaw.length > 0) {
    hfwFromTurns = turnsRaw
      .map((t: any) => {
        const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
        if (!role) return null;

        if (role === 'user') return { role: 'user', content: '[USER]' };

        const content = String(t?.content ?? t?.text ?? '').trim();
        if (!content) return null;
        return { role: 'assistant', content };
      })
      .filter(Boolean);
  }

  const hfwEffective =
    (Array.isArray(hfwRaw) && hfwRaw.length > 0 ? hfwRaw : null) ??
    (Array.isArray(hfwFromTurns) && hfwFromTurns.length > 0 ? hfwFromTurns : null);

  // 3) 「配列でない」または「空配列」を未設定扱いとして救済（ctxPackに同期）
  if (Array.isArray(hfwEffective) && hfwEffective.length > 0 && (!Array.isArray(curHfw) || curLen === 0)) {
    (userContext.ctxPack as any).historyForWriter = hfwEffective;

    // rephraseEngine 優先口：turnsForWriter をここで必ず作る（user生文は禁止）
    (userContext as any).turnsForWriter = hfwEffective
      .map((t: any) => {
        const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
        if (!role) return null;

        if (role === 'user') return { role: 'user', content: '[USER]' };

        const content = String(t?.content ?? '').trim();
        if (!content) return null;
        return { role: 'assistant', content };
      })
      .filter(Boolean);
  }
} catch {}

const __hfw = (userContext as any)?.ctxPack?.historyForWriter;
const __hfwLen = Array.isArray(__hfw) ? __hfw.length : 0;
const __t4w = (userContext as any)?.turnsForWriter;
const __t4wLen = Array.isArray(__t4w) ? __t4w.length : 0;

console.log('[IROS/_impl/rephrase.ts][USERCTX_KEYS]', {
  hasTurns: Array.isArray((userContext as any)?.turns),
  turnsLen: Array.isArray((userContext as any)?.turns) ? (userContext as any).turns.length : 0,
  hasCtxPack: !!(userContext as any)?.ctxPack,
  ctxPackKeys: (userContext as any)?.ctxPack ? Object.keys((userContext as any).ctxPack) : [],
  hasHistoryForWriter: Array.isArray(__hfw),
  historyForWriterLen: __hfwLen,
  hasTurnsForWriter: Array.isArray(__t4w),
  turnsForWriterLen: __t4wLen,
  conversationId,
  userCode,
});

try {
  const slotPlanPolicyForRephrase =
  (userContext as any)?.ctxPack?.slotPlanPolicy ??
  (meta as any)?.framePlan?.slotPlanPolicy ??
  (meta as any)?.slotPlanPolicy ??
  null;

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

    // ✅ audit/分岐のために明示的に渡す
    slotPlanPolicy: slotPlanPolicyForRephrase,

    // ✅ NEW: route.ts から来る forceRetry を rephraseEngine へ配線
    forceRetry: !!((extraMerged as any)?.forceRetry ?? (meta as any)?.extra?.forceRetry),

    // ✅ 本丸：rephraseEngine が必ず拾える top-level 配線（ctxPackが薄くなっても死なない）
    topicDigest: topicDigestForCtx,
    conversationLine: conversationLineForCtx,
    replyGoal: replyGoalForCtx,
    repeatSignal: repeatSignalForCtx,
  } as any);
  console.log('[IROS/rephraseAttach][RES_KEYS]', {
    resKeys: Object.keys(res ?? {}),
    metaKeys: Object.keys((res as any)?.meta ?? {}),
    // NOTE: rephraseSlotsFinal は out を返さない設計のため、outKeys は原則空になる
    hasOut: (res as any)?.out != null,
    outType: typeof (res as any)?.out,
    metaHasOut: (res as any)?.meta?.out != null,
    metaOutType: typeof (res as any)?.meta?.out,

    // 本命：meta.extra を見る
    metaExtraKeys: Object.keys((res as any)?.meta?.extra ?? {}),
    metaExtra_hasRephraseHead: !!(res as any)?.meta?.extra?.rephraseHead,
    metaExtra_blocksLen: Array.isArray((res as any)?.meta?.extra?.rephraseBlocks)
      ? (res as any).meta.extra.rephraseBlocks.length
      : 0,

    // raw 系の観測（fallback が効くか）
    rawLen: Number((res as any)?.meta?.rawLen ?? 0),
    rawHead: (res as any)?.meta?.rawHead ?? '',
  });

    // 正本：res.meta.extra（AFTER_ATTACH）側
    const resExtra = (res as any)?.meta?.extra ?? (res as any)?.metaForSave?.extra ?? (res as any)?.extra ?? null;

    // blocks が空でも head だけは先に反映（fallback で user seed を拾わせない）
    const resHead = TRIM((resExtra as any)?.rephraseHead ?? '');
    if (resHead) {
      (extraMerged as any).rephraseHead = TRIM((extraMerged as any).rephraseHead) || resHead;
      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseHead: TRIM((meta as any)?.extra?.rephraseHead) || resHead,
      };
    }

    // blocks 探索：res.meta.extra（正本）→ 互換 → 直下互換
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
      // ★最優先：rephraseEngine が本文を out に載せず meta.rawHead/rawLen だけ返すケース
      const rawFromRes = TRIM(
        (res as any)?.raw ??
          (res as any)?.text ??
          (res as any)?.content ??
          (res as any)?.meta?.raw ??
          (res as any)?.meta?.text ??
          (res as any)?.meta?.content ??
          (res as any)?.meta?.rawHead ??
          '',
      );

      if (rawFromRes) {
        attachBlocksFromTextOrSkip(rawFromRes, 'REPHRASE_RAW_FALLBACK');
        return;
      }

      // それでも無理なら assistant 側の候補だけ（userText には逃げない）
      const fallbackText = pickSafeAssistantText({
        candidates: [
          (extraMerged as any)?.finalAssistantTextCandidate,
          (extraMerged as any)?.finalAssistantText,
          (extraMerged as any)?.assistantText,
          (extraMerged as any)?.resolvedText,
          (extraMerged as any)?.extractedTextFromModel,
          (extraMerged as any)?.rawTextFromModel,
          (extraMerged as any)?.rephraseHead,
          (meta as any)?.extra?.rephraseHead,
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
    (extraMerged as any).rephraseHead = (extraMerged as any).rephraseHead ?? TRIM((blocks?.[0] as any)?.text ?? '');

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: true,
      rephraseApplied: true,
      rephraseReason: (meta as any)?.extra?.rephraseReason ?? 'rephrase_slots_final',
      rephraseHead: (meta as any)?.extra?.rephraseHead ?? TRIM((blocks?.[0] as any)?.text ?? ''),
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
