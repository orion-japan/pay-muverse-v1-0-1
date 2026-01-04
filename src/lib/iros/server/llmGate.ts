// src/lib/iros/server/llmGate.ts
// iros — LLM Gate (Policy -> Execute)
//
// 目的：
// - 「LLMを呼ぶ資格（allowLLM_final）」と「実際に呼ぶか」を分離する
// - 入口4通り（CALL_LLM / SKIP_SLOTPLAN / SKIP_SILENCE / SKIP_POLICY）を確定して meta に刻む
// - slotPlan は「最終(FINAL)」と「足場(SCAFFOLD)」を分離し、SCAFFOLD は本文があっても LLM を呼べる
// - ここでは “OpenAIを叩かない”。叩く直前に finalize を呼ぶ運用
//
// ✅ 修正点（v2 fix）
// - finalAssistantTextNow が空でも、slots から candidate を組み立てる
// - SCAFFOLD + slotsOk でも「現時点本文が空」なら置換対象がないため SKIP_SLOTPLAN（LLM無駄打ち防止）
// - ログの finalAssistantTextLen/Head は candidate を含めた “実質本文” を出す
// - ✅ SKIP 系 decision に resolvedText を必ず載せ、呼び出し側が本文採用できるようにする
//
/* eslint-disable @typescript-eslint/no-explicit-any */

export type LlmGateDecision =
  | { entry: 'SKIP_POLICY'; reason: string; resolvedText?: string | null }
  | { entry: 'SKIP_SILENCE'; reason: string; resolvedText?: string | null }
  | { entry: 'SKIP_SLOTPLAN'; reason: string; resolvedText?: string | null }
  | { entry: 'CALL_LLM'; reason: string; resolvedText?: null };

export type SlotPlanPolicy = 'FINAL' | 'SCAFFOLD' | 'UNKNOWN';

export type LlmGateProbeInput = {
  conversationId: string;
  userCode: string;

  // 「資格」: handleIrosReply.ts で finalAllow を確定した値
  allowLLM_final: boolean;

  // 周辺状況（推測しない。手元にある値だけ渡す）
  brakeReason?: string | null; // ex.brakeReleaseReason 等
  speechAct?: string | null; // SILENCE/FORWARD/COMMIT 等
  finalAssistantTextNow?: string | null; // 現時点の本文（slotPlanが既にあるなら非空）
  slotPlanLen?: number | null; // 計画スロット数
  hasSlots?: boolean | null; // slotPlanの有無が分かるなら

  // ✅ slotPlan の性質
  // - FINAL: その本文を最終として返してよい（LLM不要）
  // - SCAFFOLD: 会話を死なせない足場。本文があっても LLMで置換してよい
  slotPlanPolicy?: SlotPlanPolicy | null;

  // ✅ 追加：slots から candidate を作るための meta（任意）
  // - 呼び出し側で渡せるなら渡す（渡せないなら従来通り）
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

    // ✅ ここは「実質本文（candidate含む）」の長さ/先頭に変更
    finalAssistantTextLen: number;
    finalAssistantTextHead: string;

    llmEntry: LlmGateDecision['entry'];
    llmSkipReason: string | null;

    // ✅ デバッグ用（壊さないため任意）
    finalAssistantTextCandidateLen?: number | null;
    finalAssistantTextCandidateHead?: string | null;
  };
};

// 小さめ整形（ログ用）
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

// ✅ slots 抽出（metaの持ち方の揺れを吸収）
function extractSlotsObj(meta: any): any | null {
  if (!meta || typeof meta !== 'object') return null;

  // いま実際に slots が入り得る場所を優先順で拾う
  const candidates = [
    meta?.framePlan?.slots, // ✅ まずここ（あなたのログの流れ的に最有力）
    meta?.framePlan?.framePlan?.slots, // Orchestratorが二重に包んだ場合
    meta?.framePlan?.slotPlan?.slots, // 旧/揺れ
    meta?.slotPlan?.slots, // 旧/揺れ
    meta?.slots, // 直下（古い形）
    meta?.extra?.framePlan?.slots, // extra 側に入ってしまう揺れ対策
  ];

  for (const s of candidates) {
    if (!s) continue;

    // array でも object でも buildTextFromSlots は処理できる（entries で回るため）
    if (Array.isArray(s) && s.length > 0) return s;
    if (typeof s === 'object' && Object.keys(s).length > 0) return s;
  }

  return null;
}

function buildTextFromSlots(slotsObj: Record<string, any> | null): string | null {
  if (!slotsObj) return null;

  const preferred = ['core', 'add', 'one', 'two', 'three', 'close', 'ending'];
  const keysAll = Object.keys(slotsObj);

  const keys: string[] = [];
  for (const k of preferred) if (keysAll.includes(k)) keys.push(k);
  for (const k of keysAll) if (!keys.includes(k)) keys.push(k);

  const parts: string[] = [];
  for (const k of keys) {
    const v = (slotsObj as any)[k];
    if (!v) continue;

    const t =
      typeof v === 'string'
        ? v
        : typeof (v as any)?.text === 'string'
          ? (v as any).text
          : typeof (v as any)?.content === 'string'
            ? (v as any).content
            : '';

    const s = normText(t);
    if (s) parts.push(s);
  }

  const out = parts.join('\n');
  return out.length ? out : null;
}

/**
 * PROBE: 「どの入口に行くつもりか」を確定して meta へ刻むための判定。
 * - ここでは LLM を叩かない
 */
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

  // ✅ candidate（slotPlanの足場本文）を組み立て
  const slotsObj = extractSlotsObj(meta);
  const candidateRaw = normText(buildTextFromSlots(slotsObj) ?? '');
  const candidateLen = candidateRaw.length;

  // ✅ “実質本文” は textNow が優先。空なら candidate を採用。
  const effectiveText = textNowLen > 0 ? textNowRaw : candidateRaw;
  const effectiveLen = effectiveText.length;

  // (A) 資格なし → 100% SKIP_POLICY
  if (!allowLLM_final) {
    const decision: LlmGateDecision = {
      entry: 'SKIP_POLICY',
      reason: 'allowLLM_final=false',
      resolvedText: effectiveText.length ? effectiveText : null,
    };
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
        llmSkipReason: decision.reason,
        finalAssistantTextCandidateLen: candidateLen || null,
        finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
      },
    };
  }

  // (B) 明示沈黙（例: Q1_SUPPRESS） → SKIP_SILENCE
  if (
    String(brakeReason ?? '') === 'Q1_SUPPRESS' ||
    String(speechAct ?? '').toUpperCase() === 'SILENCE'
  ) {
    const decision: LlmGateDecision = {
      entry: 'SKIP_SILENCE',
      reason: 'brakeReason=Q1_SUPPRESS or speechAct=SILENCE',
      resolvedText: effectiveText.length ? effectiveText : null,
    };
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
        llmSkipReason: decision.reason,
        finalAssistantTextCandidateLen: candidateLen || null,
        finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
      },
    };
  }

  // (C) slotPlan がある場合の扱い
  const slotsOk =
    (typeof slotPlanLen === 'number' && slotPlanLen > 0) || hasSlots === true;

  // ✅ FINAL slotPlan は「最終本文」なので LLM不要 → SKIP_SLOTPLAN
  // - textNow が空でも candidate が作れるなら “本文はある” 扱いにする
  if (slotsOk && effectiveLen > 0 && policy === 'FINAL') {
    const decision: LlmGateDecision = {
      entry: 'SKIP_SLOTPLAN',
      reason: 'slotPlanPolicy=FINAL and produced non-empty text (effective)',
      resolvedText: effectiveText.length ? effectiveText : null,
    };
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
        llmSkipReason: decision.reason,
        finalAssistantTextCandidateLen: candidateLen || null,
        finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
      },
    };
  }

  // ✅ SCAFFOLD slotPlan は「足場」。
  // - テンプレ固定を防ぐため、SCAFFOLD は「常に」CALL_LLM にする。
  if (slotsOk && policy === 'SCAFFOLD') {
    const decision: LlmGateDecision = {
      entry: 'CALL_LLM',
      reason: 'slotPlanPolicy=SCAFFOLD (always generate to avoid template lock)',
      resolvedText: null,
    };

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
        llmSkipReason: null,
        finalAssistantTextCandidateLen: candidateLen || null,
        finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
      },
    };
  }

  // (D) 資格あり + 沈黙ではない + slotPlanが本文を作れてない/不明 → CALL_LLM
  const decision: LlmGateDecision = {
    entry: 'CALL_LLM',
    reason: 'eligible and no FINAL slotPlan output',
    resolvedText: null,
  };

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
      llmSkipReason: null,
      finalAssistantTextCandidateLen: candidateLen || null,
      finalAssistantTextCandidateHead: candidateLen ? head(candidateRaw) : null,
    },
  };
}

/**
 * meta.extra に gate 情報を刻む（必ず上書き）
 * - out.metaForSave.extra.llmGate を単一ソースにする
 */
export function writeLlmGateToMeta(
  metaForSave: any,
  patch: LlmGateProbeOutput['patch'],
): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;
  metaForSave.extra = metaForSave.extra ?? {};
  (metaForSave.extra as any).llmGate = {
    ...(metaForSave.extra as any).llmGate,
    ...patch,
    at: new Date().toISOString(),
  };
}

/**
 * ログ（必ず出す）
 */
export function logLlmGate(
  tag: 'PROBE' | 'FINAL',
  args: {
    conversationId: string;
    userCode: string;
    patch: LlmGateProbeOutput['patch'];
  },
): void {
  const { conversationId, userCode, patch } = args;
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

    // ✅ 追加（見たい時だけ）
    finalAssistantTextCandidateLen: patch.finalAssistantTextCandidateLen ?? null,
    finalAssistantTextCandidateHead: patch.finalAssistantTextCandidateHead ?? null,
  });
}
