// src/lib/iros/server/llmGate.ts
// iros — LLM Gate (Policy -> Execute)
//
// 目的：
// - 「LLMを呼ぶ資格（allowLLM_final）」と「実際に呼ぶか」を分離する
// - 入口4通り（CALL_LLM / SKIP_SLOTPLAN / SKIP_SILENCE / SKIP_POLICY）を確定して meta に刻む
// - slotPlan は「最終(FINAL)」と「足場(SCAFFOLD)」を分離する
// - ここでは “OpenAIを叩かない”。叩く直前に finalize を呼ぶ運用
//
// ✅ v2 方針（重要 / A案 正式）
// - 「水増し」はしない
// - LLM には必ず “下書き本文（effectiveText）” を渡す（CALL_LLM のとき）
// - SCAFFOLD は “LLM自体を呼ばない”（混乱源「呼ぶのに採用しない」を構造で排除）
// - SKIP 系 decision には resolvedText を必ず載せる
// - CALL_LLM でも resolvedText を載せ、デバッグ/再利用に使えるようにする
//
/* eslint-disable @typescript-eslint/no-explicit-any */

export type LlmGateDecision =
  | { entry: 'SKIP_POLICY'; reason: string; resolvedText?: string | null }
  | { entry: 'SKIP_SILENCE'; reason: string; resolvedText?: string | null }
  | { entry: 'SKIP_SLOTPLAN'; reason: string; resolvedText?: string | null }
  | { entry: 'CALL_LLM'; reason: string; resolvedText?: string | null };

export type SlotPlanPolicy = 'FINAL' | 'SCAFFOLD' | 'UNKNOWN';

export type LlmGateProbeInput = {
  conversationId: string;
  userCode: string;

  // 「資格」: handleIrosReply.ts で finalAllow を確定した値
  allowLLM_final: boolean;

  // 周辺状況（推測しない）
  brakeReason?: string | null;
  speechAct?: string | null;
  finalAssistantTextNow?: string | null;
  slotPlanLen?: number | null;
  hasSlots?: boolean | null;

  // slotPlan の性質
  slotPlanPolicy?: SlotPlanPolicy | null;

  // slot から candidate を作るための meta
  meta?: any;
};

export type LlmGateProbeOutput = {
  decision: LlmGateDecision;
  patch: {
    allowLLM_final: boolean;
    brakeReason: string | null;
    speechAct: string | null;
    slotPlanLen: number | null;
    hasSlots: boolean | null;
    slotPlanPolicy: SlotPlanPolicy;

    // 実質本文（candidate含む）
    finalAssistantTextLen: number;
    finalAssistantTextHead: string;

    llmEntry: LlmGateDecision['entry'];
    llmSkipReason: string | null;

    // デバッグ用
    finalAssistantTextCandidateLen?: number | null;
    finalAssistantTextCandidateHead?: string | null;
  };
};

// ---------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------

function head(s: string, n = 48): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function normPolicy(v: any): SlotPlanPolicy {
  const s = String(v ?? '').trim().toUpperCase();
  if (s === 'FINAL') return 'FINAL';
  if (s === 'SCAFFOLD') return 'SCAFFOLD';
  return 'UNKNOWN';
}

function normText(v: any): string {
  return String(v ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
}

// ---------------------------------------------------------------------
// slots helpers
// ---------------------------------------------------------------------

function extractSlotsObj(meta: any): any | null {
  if (!meta || typeof meta !== 'object') return null;

  const candidates = [
    meta?.framePlan?.slots,
    meta?.framePlan?.framePlan?.slots,
    meta?.framePlan?.slotPlan?.slots,
    meta?.slotPlan?.slots,
    meta?.slots,
    meta?.extra?.framePlan?.slots,
  ];

  for (const s of candidates) {
    if (!s) continue;
    if (Array.isArray(s) && s.length > 0) return s;
    if (typeof s === 'object' && Object.keys(s).length > 0) return s;
  }
  return null;
}

function buildTextFromSlots(slotsObj: any | null): string | null {
  if (!slotsObj) return null;

  // ✅ 両対応：object形式 / array形式
  // - array: [{ key:'OBS', content:'...' }, ...]
  // - object: { OBS:'...', SHIFT:'...', ... } または { core:{text:'...'} ... }

  const ORDER = [
    // structured
    'OBS',
    'SHIFT',
    'NEXT',
    'SAFE',
    'INSIGHT',
    // legacy / fallback
    'core',
    'add',
    'one',
    'two',
    'three',
    'close',
    'ending',
  ];

  const pickText = (v: any): string => {
    const t =
      typeof v === 'string'
        ? v
        : typeof v?.text === 'string'
          ? v.text
          : typeof v?.content === 'string'
            ? v.content
            : typeof v?.value === 'string'
              ? v.value
              : typeof v?.message === 'string'
                ? v.message
                : typeof v?.out === 'string'
                  ? v.out
                  : '';
    return normText(t);
  };

  // (1) Array slots
  if (Array.isArray(slotsObj)) {
    const items = slotsObj
      .map((s: any) => {
        const key = String(s?.key ?? s?.id ?? s?.slotId ?? s?.name ?? '').trim();
        const text = pickText(s);
        return { key, text };
      })
      .filter((x) => x.text.length > 0);

    if (items.length === 0) return null;

    // sort by ORDER
    items.sort((a, b) => {
      const ia = ORDER.indexOf(a.key);
      const ib = ORDER.indexOf(b.key);
      if (ia === -1 && ib === -1) return a.key.localeCompare(b.key);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const out = items.map((x) => x.text).join('\n');
    return out.length ? out : null;
  }

  // (2) Object slots
  if (typeof slotsObj === 'object') {
    const keysAll = Object.keys(slotsObj);

    const keys: string[] = [];
    for (const k of ORDER) if (keysAll.includes(k)) keys.push(k);
    for (const k of keysAll) if (!keys.includes(k)) keys.push(k);

    const parts: string[] = [];
    for (const k of keys) {
      const v = (slotsObj as any)[k];
      const s = pickText(v);
      if (s) parts.push(s);
    }

    const out = parts.join('\n');
    return out.length ? out : null;
  }

  return null;
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

export function probeLlmGate(input: LlmGateProbeInput): LlmGateProbeOutput {
  const {
    allowLLM_final,
    brakeReason = null,
    speechAct = null,
    finalAssistantTextNow = null,
    slotPlanLen = null,
    hasSlots = null,
    slotPlanPolicy = null,
    meta = null,
  } = input;

  const policy = normPolicy(slotPlanPolicy);

  const textNowRaw = normText(finalAssistantTextNow);
  const textNowLen = textNowRaw.length;

  const slotsObj = extractSlotsObj(meta);
  const candidateRaw = normText(buildTextFromSlots(slotsObj) ?? '');
  const candidateLen = candidateRaw.length;

  // ✅ 実質本文：textNow 優先、なければ candidate
  const effectiveText = textNowLen > 0 ? textNowRaw : candidateRaw;
  const effectiveLen = effectiveText.length;

  const mkPatch = (decision: LlmGateDecision): LlmGateProbeOutput => {
    return {
      decision,
      patch: {
        allowLLM_final,
        brakeReason,
        speechAct,
        slotPlanLen,
        hasSlots,
        slotPlanPolicy: policy,

        finalAssistantTextLen: effectiveLen,
        finalAssistantTextHead: head(effectiveText),

        llmEntry: decision.entry,
        llmSkipReason: decision.entry === 'CALL_LLM' ? null : decision.reason,

        finalAssistantTextCandidateLen: candidateLen || null,
        finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
      },
    };
  };

  // (A) 資格なし
  if (!allowLLM_final) {
    return mkPatch({
      entry: 'SKIP_POLICY',
      reason: 'allowLLM_final=false',
      resolvedText: effectiveLen ? effectiveText : null,
    });
  }

  // (B) 明示沈黙
  if (
    String(brakeReason ?? '') === 'Q1_SUPPRESS' ||
    String(speechAct ?? '').toUpperCase() === 'SILENCE'
  ) {
    return mkPatch({
      entry: 'SKIP_SILENCE',
      reason: 'brakeReason=Q1_SUPPRESS or speechAct=SILENCE',
      resolvedText: effectiveLen ? effectiveText : null,
    });
  }

  const slotsOk =
    (typeof slotPlanLen === 'number' && slotPlanLen > 0) || hasSlots === true;

  // (C) FINAL slotPlan → LLM不要（すでに本文がある）
  if (slotsOk && effectiveLen > 0 && policy === 'FINAL') {
    return mkPatch({
      entry: 'SKIP_SLOTPLAN',
      reason: 'slotPlanPolicy=FINAL and produced non-empty text',
      resolvedText: effectiveText,
    });
  }

  // (D) ✅ SCAFFOLD（正式/A案）：LLM自体を呼ばない
  // - “呼ぶのに採用しない” という混乱の温床を構造的に消す
  // - SCAFFOLD は slotPlan/seed を render-v2 側で表示する
  if (slotsOk && policy === 'SCAFFOLD') {
    return mkPatch({
      entry: 'SKIP_SLOTPLAN',
      reason: 'SCAFFOLD_POLICY__NO_LLM',
      resolvedText: effectiveLen ? effectiveText : null,
    });
  }

  // (E) slots があるが policy が UNKNOWN：守りで CALL_LLM（seed を渡す）
  if (slotsOk) {
    return mkPatch({
      entry: 'CALL_LLM',
      reason: 'slotsOk but slotPlanPolicy=UNKNOWN (fallback to CALL_LLM)',
      resolvedText: effectiveLen ? effectiveText : null,
    });
  }

  // (F) slots が無いが本文がある：そのまま返す（LLM不要）
  if (effectiveLen > 0) {
    return mkPatch({
      entry: 'SKIP_SLOTPLAN',
      reason: 'no slots but have non-empty text',
      resolvedText: effectiveText,
    });
  }

  // (G) 何も無い：最後の砦として CALL_LLM（空seedでも呼ぶ）
  return mkPatch({
    entry: 'CALL_LLM',
    reason: 'no slots and empty text (last resort)',
    resolvedText: null,
  });
}

// ---------------------------------------------------------------------
// meta write
// ---------------------------------------------------------------------

export function writeLlmGateToMeta(
  metaForSave: any,
  patch: LlmGateProbeOutput['patch'],
): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;
  metaForSave.extra = metaForSave.extra ?? {};

  // ✅ 既存：ネスト（詳細）
  (metaForSave.extra as any).llmGate = {
    ...(metaForSave.extra as any).llmGate,
    ...patch,
    at: new Date().toISOString(),
  };

  // ✅ 追加：直下ミラー（DB検索用 / SQLをそのまま活かす）
  (metaForSave.extra as any).llmEntry = patch.llmEntry;
  (metaForSave.extra as any).llmSkipReason = patch.llmSkipReason;
}

// ---------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------

export function logLlmGate(
  tag: 'PROBE' | 'FINAL',
  args: {
    conversationId: string;
    userCode: string;
    patch: LlmGateProbeOutput['patch'];
    decision?: LlmGateDecision;
  },
): void {
  const { conversationId, userCode, patch, decision } = args;
  console.log(`[IROS/LLM_GATE][${tag}]`, {
    conversationId,
    userCode,
    llmEntry: patch.llmEntry,
    llmSkipReason: patch.llmSkipReason,
    allowLLM_final: patch.allowLLM_final,
    brakeReason: patch.brakeReason,
    speechAct: patch.speechAct,
    slotPlanLen: patch.slotPlanLen,
    hasSlots: patch.hasSlots,
    slotPlanPolicy: patch.slotPlanPolicy,
    finalAssistantTextLen: patch.finalAssistantTextLen,
    finalAssistantTextHead: patch.finalAssistantTextHead,
    finalAssistantTextCandidateLen: patch.finalAssistantTextCandidateLen ?? null,
    finalAssistantTextCandidateHead: patch.finalAssistantTextCandidateHead ?? null,
    resolvedTextLen: decision?.resolvedText
      ? String(decision.resolvedText).length
      : null,
  });
}
