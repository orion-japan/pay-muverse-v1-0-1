// src/lib/iros/server/runLlmGate.ts
// iros — runLlmGate (always-pass wrapper)
// 目的：
// - probeLlmGate を必ず通し、meta.extra.llmGate に刻む
// - textNow が空でも slots から candidate を作り、resolvedText として返す
// - 呼び出し側（handleIrosReply / route.ts）が本文採用できるようにする
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

  // ✅ SKIP系のときに採用すべき本文（slots candidate含む）
  resolvedText: string | null;

  // デバッグ可視化（任意）
  debug: {
    textNowLen: number;
    candidateLen: number | null;
    slotPlanLen: number | null;
    hasSlots: boolean | null;
    slotPlanPolicy: SlotPlanPolicy;
  };
};

function inferSlotPlanLen(meta: any): number | null {
  try {
    const slotsObj =
      meta?.framePlan?.slots ??
      meta?.framePlan?.framePlan?.slots ??
      meta?.framePlan?.slotPlan?.slots ??
      meta?.slotPlan?.slots ??
      meta?.slots ??
      meta?.extra?.framePlan?.slots ??
      null;

    if (!slotsObj) return null;
    if (Array.isArray(slotsObj)) return slotsObj.length || null;
    if (typeof slotsObj === 'object') {
      const n = Object.keys(slotsObj).length;
      return n > 0 ? n : null;
    }
    return null;
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

  const metaForProbe = metaForCandidate ?? metaForSave;

  const brakeReason =
    metaForSave?.brakeReason ??
    metaForSave?.speechInput?.brakeReleaseReason ??
    metaForSave?.extra?.brakeReason ??
    null;

  const speechAct =
    metaForSave?.speechAct ??
    metaForSave?.extra?.speechAct ??
    null;

  let slotPlanLen: number | null =
    metaForSave?.slotPlanLen ??
    metaForSave?.speechInput?.slotPlanLen ??
    metaForSave?.extra?.slotPlanLen ??
    null;

  // hasSlots は “濃いmeta” も見る（save側だけに寄せない）
  const hasSlots: boolean | null =
    metaForSave?.hasSlots ??
    metaForProbe?.hasSlots ??
    Boolean(metaForProbe?.framePlan?.slots) ??
    Boolean(metaForProbe?.slotPlan?.slots) ??
    Boolean(metaForProbe?.slots) ??
    null;

  // policy も “濃いmeta” を見る（save側だけに寄せない）
  const slotPlanPolicy =
    metaForSave?.slotPlanPolicy ??
    metaForProbe?.framePlan?.slotPlanPolicy ??
    metaForProbe?.slotPlanPolicy ??
    metaForSave?.framePlan?.slotPlanPolicy ??
    metaForSave?.extra?.slotPlanPolicy ??
    null;

  const textNow = String(assistantTextNow ?? '').trim();

  // slotPlanLen が無いなら推定して保存metaにも入れる
  if (slotPlanLen == null) {
    const n = inferSlotPlanLen(metaForProbe);
    if (typeof n === 'number') {
      slotPlanLen = n;
      try {
        if (metaForSave && typeof metaForSave === 'object') {
          metaForSave.slotPlanLen = metaForSave.slotPlanLen ?? n;
        }
      } catch {}
    }
  }

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

  // ✅ metaへ刻む＆ログ
  writeLlmGateToMeta(metaForSave, probe.patch);
  logLlmGate(tag, { conversationId, userCode, patch: probe.patch });

  // ✅ decision.resolvedText を優先して返す（patchではなくdecisionが正）
  const resolvedText =
    (probe.decision as any)?.resolvedText != null
      ? String((probe.decision as any).resolvedText ?? '').trim() || null
      : null;

  const candidateLen =
    typeof (probe.patch as any)?.finalAssistantTextCandidateLen === 'number'
      ? (probe.patch as any).finalAssistantTextCandidateLen
      : null;

  return {
    llmEntry: (probe.patch as any)?.llmEntry ?? null,
    resolvedText,
    debug: {
      textNowLen: textNow.length,
      candidateLen,
      slotPlanLen: slotPlanLen ?? null,
      hasSlots,
      slotPlanPolicy: probe.patch.slotPlanPolicy,
    },
  };
}
