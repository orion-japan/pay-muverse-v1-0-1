// src/app/api/agent/iros/reply/_impl/rephrase.ts
/* eslint-disable @typescript-eslint/no-explicit-any */

import { pickSpeechAct } from '../_helpers';

import {
  extractSlotsForRephrase,
  rephraseSlotsFinal,
} from '@/lib/iros/language/rephraseEngine';

type RenderBlock = { text: string | null | undefined; kind?: string };

function pickFallbackAssistantText(args: {
  allowUserTextAsLastResort?: boolean; // NOTE: 互換のため受けるが userText は返さない
  userText?: string | null;

  assistantText?: string | null;
  content?: string | null;
  text?: string | null;

  candidates?: any[];

  [k: string]: any;
}) {
  const norm = (v: any) => String(v ?? '').trim();

  if (Array.isArray(args.candidates) && args.candidates.length > 0) {
    for (const c of args.candidates) {
      const s = norm(c);
      if (s) return s;
    }
  }

  const a = norm(args.assistantText);
  if (a) return a;

  const c = norm(args.content);
  if (c) return c;

  const x = norm(args.text);
  if (x) return x;

  // userText は返さない（オウム返し事故防止）
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

function buildFallbackRenderBlocksFromFinalText(finalText: string): RenderBlock[] {
  const t = String(finalText ?? '').trim();
  if (!t) return [];

  const splitToBlocks = (s: string): string[] => {
    const raw = String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
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

  const attachFallbackBlocksFromText = (finalText: string, attachReason: string) => {
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
        });
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
        rephraseHead: (meta?.extra as any)?.rephraseHead ?? pickedTrim,
      };

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

      return true;
    } catch (err: any) {
      console.error('[IROS/rephraseAttach][FALLBACK_ERROR]', {
        conversationId,
        userCode,
        attachReason,
        message: String(err?.message ?? err),
      });
      return false;
    }
  };

  // ---- 1) gate ----
  const enabled = String(process.env.IROS_REPHRASE_FINAL_ENABLED ?? '1').trim() !== '0';
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

  if (!allowIT && upper(effectiveMode) === 'IT') {
    setSkip('SKIP_BY_EFFECTIVE_MODE_IT', { effectiveMode });

    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
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
    return;
  }

  // ---- 2) idempotent ----
  if (Array.isArray((extraMerged as any)?.rephraseBlocks) && (extraMerged as any).rephraseBlocks.length > 0) {
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

    const ensuredText = String(fallbackText ?? '').trim() || String(userText ?? '').trim();

    let ok = false;

    if (ensuredText) {
      ok = attachFallbackBlocksFromText(ensuredText, 'FALLBACK_FROM_RESULT_TEXT_NO_SLOTS');
    }

    if (!ok && ensuredText) {
      const fb = buildFallbackRenderBlocksFromFinalText(ensuredText);

      (extraMerged as any).rephraseBlocks = fb;
      (extraMerged as any).rephraseBlocksAttached = fb.length > 0;
      (extraMerged as any).rephraseAttachSkipped = true;
      (extraMerged as any).rephraseLLMApplied = false;
      (extraMerged as any).rephraseApplied = false;
      (extraMerged as any).rephraseReason =
        (extraMerged as any)?.rephraseReason ?? 'fallback_blocks_no_slots_hard_attach';
      (extraMerged as any).rephraseHead = (extraMerged as any)?.rephraseHead ?? ensuredText;

      ok = fb.length > 0;

      console.warn('[IROS/rephraseAttach][NO_SLOTS_HARD_ATTACH]', {
        blocksLen: fb.length,
        head: String(ensuredText).slice(0, 120),
      });
    }

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: true,
      rephraseBlocksAttached: Boolean(ok),
      rephraseLLMApplied: false,
      rephraseApplied: false,
      rephraseReason:
        (meta as any)?.extra?.rephraseReason ??
        (extraMerged as any)?.rephraseReason ??
        'no_slots_skip_llm_blocks_attached',
    };

    (extraMerged as any).rephraseAttachSkipped = true;
    (extraMerged as any).rephraseBlocksAttached = Boolean((extraMerged as any).rephraseBlocksAttached ?? ok);
    (extraMerged as any).rephraseLLMApplied = false;
    (extraMerged as any).rephraseApplied = false;

    return;
  }

  // ---- 4) minimal userContext（直近履歴 + last_state） ----
  const normalizedHistory = normalizeHistoryMessages(historyMessages ?? null);

  const userContext = {
    conversation_id: String(conversationId),

    last_state: memoryStateForCtx ?? null,

    itxStep: memoryStateForCtx?.itxStep ?? null,
    itxReason: memoryStateForCtx?.itxReason ?? null,

    intentBand:
      (memoryStateForCtx?.depthStage ?? null) ||
      (typeof (meta as any)?.depth_stage === 'string' ? String((meta as any).depth_stage).trim() : null) ||
      (typeof (meta as any)?.depthStage === 'string' ? String((meta as any).depthStage).trim() : null) ||
      null,

    historyMessages: normalizedHistory.length ? normalizedHistory : undefined,
  };

  // ---- 5) call LLM ----
  try {
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
      (meta as any)?.framePlan?.inputKind ??
        (meta as any)?.inputKind ??
        (userContext as any)?.framePlan?.inputKind ??
        '',
    ).toLowerCase();

    // =========================================================
    // ✅ 診断 FINAL(IR) は LLM rephrase を呼ばない（コスト/崩れ防止）
    // ただし seedだけだとテンプレ体感になるため、追記bridgeのみ生成可
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
      modeNow === 'diagnosis' ||
      presentationKindNow === 'diagnosis' ||
      Boolean((extraMerged as any)?.isIrDiagnosisTurn);

    const allowDiagnosisFinalRephrase = (() => {
      const v = String(process.env.IROS_REPHRASE_ALLOW_DIAGNOSIS_FINAL ?? '').trim().toLowerCase();
      return v === '1' || v === 'true' || v === 'on' || v === 'yes' || v === 'enabled';
    })();

    const shouldSkipRephraseLLMForDiagnosisFinal =
      isDiagnosisTurn && slotPlanPolicyNow === 'FINAL' && !allowDiagnosisFinalRephrase;

    if (shouldSkipRephraseLLMForDiagnosisFinal) {
      const ensuredText = pickFallbackAssistantText({
        allowUserTextAsLastResort: true,
        userText,
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

      let bridgeText = '';
      try {
        const mod = await import('@/lib/llm/chatComplete');
        const chatComplete = (mod as any).chatComplete as any;

        const sys = [
          'あなたは iros の「Diagnosis Bridge Writer」。',
          '目的：診断本文（固定表示）の下に置く、短い追記（bridge）を生成する。',
          '',
          '制約：',
          '- 2〜4段落、合計 120〜220 文字程度（短くてよい）',
          '- ラベル/見出し/箇条書きは禁止',
          '- 「かもしれません」「でしょうか」等の弱い推測を避ける（断言しすぎも避ける）',
          '- 質問は最大1つまで（基本は0）',
          '- 「共鳴」「メタ」「フェーズ」など内部用語を出さない',
          '',
          '入力：',
          '- 最新のユーザー文と、診断本文（seed）が渡される。',
          '出力：',
          '- 追記本文のみ（余計な前置きは禁止）',
        ].join('\n');

        const userMsg = [
          '【ユーザー最新文】',
          String(userText ?? '').trim(),
          '',
          '【診断本文（固定表示）】',
          String(ensuredText ?? '').trim(),
        ].join('\n');

        const r = await chatComplete({
          purpose: 'reply',
          model,
          temperature: 0.2,
          responseFormat: 'text',
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg },
          ],
          max_tokens: 180,
        });

        const t = String(r?.text ?? r?.content ?? '').trim();
        if (t) bridgeText = t;
      } catch (e) {
        console.warn('[IROS/rephraseAttach][DIAGNOSIS_FINAL_BRIDGE][ERR]', {
          conversationId,
          userCode,
          err: String((e as any)?.message ?? e),
        });
      }

      const finalText = bridgeText ? `${ensuredText}\n\n${bridgeText}` : ensuredText;

      attachFallbackBlocksFromText(finalText, 'DIAGNOSIS_FINAL_SEED_PLUS_BRIDGE');

      (extraMerged as any).finalAssistantTextCandidate = finalText;
      (extraMerged as any).finalAssistantText = finalText;
      (extraMerged as any).assistantText = finalText;
      (extraMerged as any).resolvedText = finalText;
      (extraMerged as any).extractedTextFromModel = finalText;
      (extraMerged as any).rawTextFromModel = finalText;

      meta.extra = {
        ...(meta.extra ?? {}),
        rephraseAttachSkipped: true,
        rephraseBlocksAttached: true,
        rephraseLLMApplied: Boolean(bridgeText),
        rephraseApplied: Boolean(bridgeText),
        rephraseReason: bridgeText ? 'diagnosis_final_seed_plus_bridge' : 'diagnosis_final_seed_only',
      };

      (extraMerged as any).rephraseAttachSkipped = true;
      return;
    }

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

    const blocks = (res as any)?.meta?.blocks ?? (res as any)?.blocks ?? null;

    if (!Array.isArray(blocks) || blocks.length === 0) {
      const fallbackText = pickFallbackAssistantText({
        allowUserTextAsLastResort: true,
        userText,
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

      attachFallbackBlocksFromText(fallbackText || String(userText ?? '').trim(), 'REPHRASE_EMPTY_FALLBACK');
      return;
    }

    // attach
    (extraMerged as any).rephraseBlocks = blocks;
    (extraMerged as any).rephraseBlocksAttached = true;
    (extraMerged as any).rephraseLLMApplied = true;
    (extraMerged as any).rephraseApplied = true;
    (extraMerged as any).rephraseReason = (extraMerged as any).rephraseReason ?? 'rephrase_slots_final';
    (extraMerged as any).rephraseHead =
      (extraMerged as any).rephraseHead ??
      String((blocks?.[0] as any)?.text ?? '').trim();

    meta.extra = {
      ...(meta.extra ?? {}),
      rephraseAttachSkipped: false,
      rephraseBlocksAttached: true,
      rephraseLLMApplied: true,
      rephraseApplied: true,
      rephraseReason: (meta as any)?.extra?.rephraseReason ?? 'rephrase_slots_final',
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

    // 例外時も UI ブロックだけは確保
    const fallbackText = pickFallbackAssistantText({
      allowUserTextAsLastResort: true,
      userText,
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

    attachFallbackBlocksFromText(fallbackText || String(userText ?? '').trim(), 'REPHRASE_EXCEPTION_FALLBACK');
  }
}
