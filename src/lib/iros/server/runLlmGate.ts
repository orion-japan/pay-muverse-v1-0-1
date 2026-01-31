// src/lib/iros/server/runLlmGate.ts
// iros — runLlmGate (always-pass wrapper)
//
// 目的：
// - probeLlmGate を必ず通し、meta.extra.llmGate に刻む（監査）
// - 呼び出し側（handleIrosReply / route.ts）が本文採用できるように、
//   “採用候補” の提示は最小限にする（single-writer 尊重）
//
// ✅ 憲法（安全）方針：
// - Default deny（情報欠損/不明は安全側）
// - FINAL では slot/candidate は user-facing 文ではない（@TAG/JSONメタ）
//   → resolvedText を返さない（漏洩経路を遮断）
// - resolvedText を返すのは “SCAFFOLD が明確なときだけ”
// - tag='FINAL' は patch に依存せず最優先で FINAL 扱い（遮断）
//
// NOTE：ここは “採用の決定” をしない。
// - llmGate の結果を刻むだけ
// - 本文採用は上位（route/postprocess/render）で行う

/* eslint-disable @typescript-eslint/no-explicit-any */

import {
  probeLlmGate,
  writeLlmGateToMeta,
  logLlmGate,
  type SlotPlanPolicy,
} from './llmGate';

export type RunLlmGateArgs = {
  tag: 'PROBE' | 'FINAL';
  conversationId: string;
  userCode: string;

  // 保存対象meta（ここへ刻む）
  metaForSave: any;

  // candidate抽出に使う “濃いmeta”（slots/framePlanが入ってる方）
  metaForCandidate?: any;

  // handleIrosReply 側で確定した資格
  allowLLM_final: boolean;

  // 現時点本文（空でも良い）
  assistantTextNow?: string | null;
};

export type RunLlmGateResult = {
  llmEntry: 'CALL_LLM' | 'SKIP_POLICY' | 'SKIP_SILENCE' | 'SKIP_SLOTPLAN' | null;

  // ✅ SCAFFOLD のときだけ返す “採用候補”
  // ⚠️ FINAL または policy 不明は null（漏洩/誤採用を防ぐ）
  resolvedText: string | null;

  // ✅ 追加：CALL_LLM の seed（handle側が拾う）
  rewriteSeed: string | null;

  // デバッグ可視化（任意）
  debug: {
    textNowLen: number;
    candidateLen: number | null;
    slotPlanLen: number | null;
    hasSlots: boolean | null;
    slotPlanPolicy: SlotPlanPolicy | null;
    slotPlanLenFrom: string | null;
    denyResolvedTextReason: string | null;

    // ✅ 追加：seed が取れてるか監査
    rewriteSeedLen: number;
  };
};

type InferLenResult = { len: number | null; from: string | null };

function safeTrim(s: unknown): string {
  return String(s ?? '').trim();
}

function isPolicy(v: unknown): v is SlotPlanPolicy {
  const t = safeTrim(v);
  return t === 'FINAL' || t === 'SCAFFOLD';
}

/**
 * slots を “どこから拾ったか” も返す（監査用）
 */
function inferSlotPlanLen(meta: any): InferLenResult {
  try {
    const candidates: Array<{ v: any; from: string }> = [
      { v: meta?.framePlan?.slots, from: 'framePlan.slots' },
      { v: meta?.framePlan?.framePlan?.slots, from: 'framePlan.framePlan.slots' },
      { v: meta?.framePlan?.slotPlan?.slots, from: 'framePlan.slotPlan.slots' },
      { v: meta?.slotPlan?.slots, from: 'slotPlan.slots' },
      { v: meta?.slots, from: 'slots' },
      { v: meta?.extra?.framePlan?.slots, from: 'extra.framePlan.slots' },
    ];

    for (const c of candidates) {
      const slotsObj = c.v;
      if (slotsObj == null) continue;

      if (Array.isArray(slotsObj)) {
        const n = slotsObj.length;
        return { len: n > 0 ? n : 0, from: c.from };
      }
      if (typeof slotsObj === 'object') {
        const n = Object.keys(slotsObj).length;
        return { len: n > 0 ? n : 0, from: c.from };
      }
      // それ以外は無視
    }

    return { len: null, from: null };
  } catch {
    return { len: null, from: null };
  }
}

/**
 * hasSlots の “unknown(null)” を壊さない
 * - slots の探索で「探索対象が1つでも見つかった」なら true/false を返す
 * - どこにも探索対象が無いなら null
 */
function inferHasSlots(meta: any): boolean | null {
  try {
    // 明示値があればそれを尊重（true/false 両方）
    if (typeof meta?.hasSlots === 'boolean') return meta.hasSlots;

    const probes: Array<{ exists: boolean; slots: any }> = [
      { exists: meta?.framePlan != null, slots: meta?.framePlan?.slots },
      { exists: meta?.slotPlan != null, slots: meta?.slotPlan?.slots },
      { exists: meta?.slots != null, slots: meta?.slots },
      { exists: meta?.extra?.framePlan != null, slots: meta?.extra?.framePlan?.slots },
    ];

    // “探索対象が存在するか” を判定
    const anyProbeExists = probes.some((p) => p.exists);

    if (!anyProbeExists) return null;

    // 探索対象が存在するなら、中身の有無で true/false を返す
    const hasAny =
      probes.some((p) => Array.isArray(p.slots) && p.slots.length > 0) ||
      probes.some((p) => p.slots && typeof p.slots === 'object' && !Array.isArray(p.slots) && Object.keys(p.slots).length > 0);

    return hasAny;
  } catch {
    return null;
  }
}

/**
 * slotPlanPolicy の “unknown(null)” を壊さない
 * - 明示値が取れれば FINAL/SCAFFOLD を返す
 * - 取れなければ null
 */
function inferSlotPlanPolicy(metaSave: any, metaProbe: any): SlotPlanPolicy | null {
  try {
    const candidates: Array<unknown> = [
      metaSave?.slotPlanPolicy,
      metaSave?.framePlan?.slotPlanPolicy,
      metaSave?.extra?.slotPlanPolicy,
      metaProbe?.slotPlanPolicy,
      metaProbe?.framePlan?.slotPlanPolicy,
    ];

    for (const v of candidates) {
      if (isPolicy(v)) return safeTrim(v) as SlotPlanPolicy;
    }
    return null;
  } catch {
    return null;
  }
}

function safeResolvedTextFromProbe(probe: any): string | null {
  try {
    const raw = probe?.decision?.resolvedText;
    const t = safeTrim(raw);
    return t ? t : null;
  } catch {
    return null;
  }
}

function safeCandidateLenFromPatch(patch: any): number | null {
  try {
    const n = patch?.finalAssistantTextCandidateLen;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function runLlmGate(args: RunLlmGateArgs): RunLlmGateResult {
  const {
    tag,
    conversationId,
    userCode,
    metaForSave,
    metaForCandidate,
    allowLLM_final,
    assistantTextNow,
  } = args;

  // “濃いmeta” 優先
  const metaForProbe = metaForCandidate ?? metaForSave;

  const brakeReason =
    metaForSave?.brakeReason ??
    metaForSave?.speechInput?.brakeReleaseReason ??
    metaForSave?.extra?.brakeReason ??
    null;

  const speechAct = metaForSave?.speechAct ?? metaForSave?.extra?.speechAct ?? null;

  // slotPlanLen：明示値があれば尊重。無ければ推定して metaForSave に刻む（監査可能に）
  let slotPlanLen: number | null =
    typeof metaForSave?.slotPlanLen === 'number'
      ? metaForSave.slotPlanLen
      : typeof metaForSave?.speechInput?.slotPlanLen === 'number'
        ? metaForSave.speechInput.slotPlanLen
        : typeof metaForSave?.extra?.slotPlanLen === 'number'
          ? metaForSave.extra.slotPlanLen
          : null;

  let slotPlanLenFrom: string | null = null;

  if (slotPlanLen == null) {
    const inf = inferSlotPlanLen(metaForProbe);
    slotPlanLen = inf.len;
    slotPlanLenFrom = inf.from;

    try {
      if (metaForSave && typeof metaForSave === 'object' && slotPlanLen != null) {
        metaForSave.slotPlanLen = metaForSave.slotPlanLen ?? slotPlanLen;
        // 監査用（存在しない場合だけ）
        metaForSave.slotPlanLenFrom = metaForSave.slotPlanLenFrom ?? slotPlanLenFrom;
      }
    } catch {}
  }

  // hasSlots / policy は unknown(null) を維持
  const hasSlots: boolean | null =
    typeof metaForSave?.hasSlots === 'boolean'
      ? metaForSave.hasSlots
      : inferHasSlots(metaForProbe);

  const slotPlanPolicy: SlotPlanPolicy | null = inferSlotPlanPolicy(metaForSave, metaForProbe);

  const textNow = safeTrim(assistantTextNow);

  const probe = probeLlmGate({
    conversationId,
    userCode,
    allowLLM_final,
    brakeReason,
    speechAct,
    finalAssistantTextNow: textNow,
    slotPlanLen,
    hasSlots,
    slotPlanPolicy,
    meta: metaForProbe,
  } as any);

  // ✅ metaへ刻む＆ログ（監査）
  writeLlmGateToMeta(metaForSave, probe.patch);
  logLlmGate(tag, { conversationId, userCode, patch: probe.patch });

  const resolvedTextRaw = safeResolvedTextFromProbe(probe);

  // ✅ 追加：LLM用 seed（rewriteSeed）を gate の戻り値に渡す
  const rewriteSeedRaw = safeTrim(String((probe.decision as any)?.rewriteSeed ?? ''));
  const rewriteSeed = rewriteSeedRaw.length > 0 ? rewriteSeedRaw : null;

  // --- 憲法：resolvedText を返す条件（最小化） ---
  // 1) tag='FINAL' は無条件で遮断（patchに依存しない）
  // 2) policy が SCAFFOLD と明確に分かる時だけ返す
  // 3) policy 不明(null) は安全側で遮断
  let resolvedText: string | null = null;
  let denyResolvedTextReason: string | null = null;

  if (tag === 'FINAL') {
    resolvedText = null;
    denyResolvedTextReason = 'deny:tag_is_FINAL';
  } else if (slotPlanPolicy !== 'SCAFFOLD') {
    // FINAL または null(不明) は遮断
    resolvedText = null;
    denyResolvedTextReason =
      slotPlanPolicy === 'FINAL'
        ? 'deny:policy_FINAL'
        : 'deny:policy_unknown';
  } else {
    resolvedText = resolvedTextRaw;
    denyResolvedTextReason = resolvedText ? null : 'deny:resolvedText_empty';
  }

  // ✅ gateRewriteSeed は decision 由来のみ（CALL_LLM の単一seed）
  const gateRewriteSeedRaw = String((probe.decision as any)?.rewriteSeed ?? '').trim();
  const gateRewriteSeed = gateRewriteSeedRaw.length > 0 ? gateRewriteSeedRaw : null;

  return {
    llmEntry: (probe.patch as any)?.llmEntry ?? null,

    // ✅ handleIrosReply 側で拾う seed
    rewriteSeed: gateRewriteSeed,

    resolvedText,
    debug: {
      textNowLen: textNow.length,
      candidateLen: safeCandidateLenFromPatch(probe.patch),
      slotPlanLen: slotPlanLen ?? null,
      hasSlots,
      slotPlanPolicy,
      slotPlanLenFrom,
      denyResolvedTextReason,

      // 監査：seed が実際に生成されているか
      rewriteSeedLen: gateRewriteSeed ? gateRewriteSeed.length : 0,
    },
  };
}


