// file: src/lib/iros/server/handleIrosReply.postprocess.ts
// iros - Postprocess (MIN)
// 目的：
// - orchResult から assistantText / metaForSave を確定
// - intentAnchor の検疫（汚染防止）
// - rotationState を「UIが読む最低限」に正規化（値は変えず、形だけ固定）
// - Q1_SUPPRESS + allowLLM=false + 無発話 → 本文は必ず空（沈黙止血）
// - pastStateNote 注入（条件一致のみ）
// - UnifiedAnalysis の保存（失敗しても返信は落とさない）

import type { SupabaseClient } from '@supabase/supabase-js';
import type { IrosStyle } from '@/lib/iros/system';
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

import { preparePastStateNoteForTurn } from '@/lib/iros/memoryRecall';

import {
  buildUnifiedAnalysis,
  saveUnifiedAnalysisInline,
  applyAnalysisToLastUserMessage,
} from './handleIrosReply.analysis';

export type PostProcessReplyArgs = {
  supabase: SupabaseClient;
  userCode: string;
  conversationId: string;
  userText: string;

  effectiveStyle: IrosStyle | string | null;
  requestedMode: string | undefined;

  orchResult: any;

  history?: unknown[];
  topicLabel?: string | null;
  pastStateLimit?: number;
  forceRecentTopicFallback?: boolean;

  tenantId?: string;
};

export type PostProcessReplyOutput = {
  assistantText: string;
  metaForSave: any;
};

/* =========================
 * Small helpers
 * ========================= */

function toNonEmptyString(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function normalizeText(v: unknown): string {
  return typeof v === 'string' ? v.trim() : String(v ?? '').trim();
}

function isEffectivelySilent(textRaw: unknown): boolean {
  const t = normalizeText(textRaw);
  if (!t) return true;
  const stripped = t.replace(/[🪔\s。．\.]/g, '');
  return stripped === '' || stripped === '…';
}

function getExtra(meta: any): Record<string, any> {
  return meta?.extra && typeof meta.extra === 'object' ? meta.extra : {};
}

function getBrakeReason(meta: any): string | null {
  const ex = getExtra(meta);
  const v = ex.brakeReleaseReason ?? meta?.brakeReleaseReason ?? null;
  return typeof v === 'string' ? v : null;
}

function getSpeechAllowLLM(meta: any): boolean | null {
  const ex = getExtra(meta);
  const v =
    ex.speechAllowLLM ??
    meta?.speechAllowLLM ??
    meta?.allowLLM ??
    meta?.allow_llm ??
    null;
  return typeof v === 'boolean' ? v : null;
}

function extractAssistantText(orchResult: any): string {
  if (orchResult && typeof orchResult === 'object') {
    const r: any = orchResult;

    // ✅ V2: Orchestrator/Writer が確定した本文を最優先
    const a = toNonEmptyString(r.assistantText);
    if (a) return a;

    // 互換（古い呼び出しや一部経路）
    const c = toNonEmptyString(r.content);
    if (c) return c;

    const t = toNonEmptyString(r.text);
    if (t) return t;

    return '';
  }
  return typeof orchResult === 'string' ? orchResult : '';
}

/* =========================
 * slotPlanPolicy detect (NO-UNKNOWN) + source
 * - UNKNOWN を作らない（null にする）
 * - 見つからない場合、slots があれば SCAFFOLD 推定
 * ========================= */

type SlotPlanPolicyNorm = 'SCAFFOLD' | 'FINAL';

function normSlotPlanPolicy(v: unknown): SlotPlanPolicyNorm | null {
  if (typeof v !== 'string') return null;

  const s = v.trim().toUpperCase();
  if (s === 'SCAFFOLD') return 'SCAFFOLD';
  if (s === 'FINAL') return 'FINAL';

  return null;
}

function detectSlotPlanPolicy(args: {
  metaForSave?: any;
  orchResult?: any;
  slotPlanLen?: number | null;
  hasSlots?: boolean | null;
}): { policy: SlotPlanPolicyNorm | null; from: string; raw: unknown } {
  const metaForSave = args.metaForSave ?? null;
  const orchResult = args.orchResult ?? null;

  const candidates: Array<[string, unknown]> = [
    // meta 側
    ['metaForSave.framePlan.slotPlanPolicy', metaForSave?.framePlan?.slotPlanPolicy],
    ['metaForSave.slotPlanPolicy', metaForSave?.slotPlanPolicy],
    ['metaForSave.extra.slotPlanPolicy', metaForSave?.extra?.slotPlanPolicy],

    // orchResult 側（入っていれば拾う）
    ['orchResult.slotPlanPolicy', orchResult?.slotPlanPolicy],
    ['orchResult.framePlan.slotPlanPolicy', orchResult?.framePlan?.slotPlanPolicy],
    ['orchResult.meta.framePlan.slotPlanPolicy', orchResult?.meta?.framePlan?.slotPlanPolicy],
    ['orchResult.meta.slotPlanPolicy', orchResult?.meta?.slotPlanPolicy],
  ];

  for (const [from, raw] of candidates) {
    const policy = normSlotPlanPolicy(raw);
    if (policy) {
      // 欠損補完だけ（上書きしない）
      if (metaForSave?.framePlan && metaForSave.framePlan.slotPlanPolicy == null) {
        metaForSave.framePlan = { ...metaForSave.framePlan, slotPlanPolicy: policy };
      }
      if (metaForSave && metaForSave.slotPlanPolicy == null) {
        metaForSave.slotPlanPolicy = policy;
      }
      return { policy, from, raw };
    }
  }

  // --- 推定（slots があるのに policy が無いケースを埋める） ---
  const slotsA = metaForSave?.framePlan?.slots;
  const slotsB = orchResult?.meta?.framePlan?.slots;
  const slotsC = orchResult?.framePlan?.slots;

  const slotPlanLen =
    args.slotPlanLen ??
    Math.max(
      Array.isArray(slotsA) ? slotsA.length : 0,
      Array.isArray(slotsB) ? slotsB.length : 0,
      Array.isArray(slotsC) ? slotsC.length : 0,
    );

  const hasSlots =
    args.hasSlots ??
    Boolean(
      slotsA ?? slotsB ?? slotsC, // 「slots プロパティがあるか」を優先（[] でも true）
    );

  if (hasSlots && slotPlanLen > 0) {
    const inferred: SlotPlanPolicyNorm = 'SCAFFOLD';

    // 欠損補完だけ（上書きしない）
    if (metaForSave?.framePlan && metaForSave.framePlan.slotPlanPolicy == null) {
      metaForSave.framePlan = { ...metaForSave.framePlan, slotPlanPolicy: inferred };
    }
    if (metaForSave && metaForSave.slotPlanPolicy == null) {
      metaForSave.slotPlanPolicy = inferred;
    }

    return { policy: inferred, from: 'inferred(hasSlots&&len>0)', raw: null };
  }

  return { policy: null, from: 'none', raw: null };
}

function shouldCommitSlotPlanFinalOnly(args: {
  policy: SlotPlanPolicyNorm | null;
  slotText: string;
}): boolean {
  return args.policy === 'FINAL' && String(args.slotText ?? '').trim().length > 0;
}

/* =========================
 * intentAnchor sanitize (MIN)
 * ========================= */

function pickIntentAnchorText(meta: any): string {
  const a = meta?.intentAnchor;
  if (!a) return '';
  if (typeof a === 'string') return a;
  if (typeof a === 'object') return String(a.anchor_text ?? a.anchorText ?? a.text ?? '');
  return '';
}

function pickAnchorEvent(meta: any): string | null {
  const ev =
    meta?.anchorEventType ??
    meta?.intentAnchorEventType ??
    meta?.anchor_event_type ??
    meta?.intent_anchor_event_type ??
    meta?.anchorEvent?.type ??
    null;

  return typeof ev === 'string' ? ev.trim().toLowerCase() : null;
}

function looksLikeDbRow(a: any): boolean {
  if (!a || typeof a !== 'object') return false;
  return Boolean(a.id || a.user_id || a.created_at || a.updated_at);
}

function sanitizeIntentAnchor(meta: any): void {
  if (!meta || typeof meta !== 'object') return;
  if (!meta.intentAnchor) return;

  const text = pickIntentAnchorText(meta).trim();
  const a = meta.intentAnchor;

  if (!text) {
    delete meta.intentAnchor;
    return;
  }

  if (isMetaAnchorText(text)) {
    delete meta.intentAnchor;
    return;
  }

  const ev = pickAnchorEvent(meta);
  const isRealEvent = ev === 'set' || ev === 'reset';
  if (!looksLikeDbRow(a) && !isRealEvent) {
    delete meta.intentAnchor;
    return;
  }
}

/* =========================
 * rotationState single shape (MIN)
 * - 値は変えない：拾えたものだけ正規化して置く
 * ========================= */

type DescentGate = 'closed' | 'offered' | 'accepted';
type SpinLoop = 'SRI' | 'TCF';

function normalizeDescentGate(v: any): DescentGate {
  if (v == null) return 'closed';
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as DescentGate;
  }
  return 'closed';
}

function normalizeSpinLoop(v: any): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s === 'SRI' || s === 'TCF' ? (s as SpinLoop) : null;
}

function normalizeDepth(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function ensureRotationState(metaForSave: any, orchResult: any): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;

  const or = orchResult && typeof orchResult === 'object' ? (orchResult as any) : null;
  const ex = getExtra(metaForSave);

  // ✅ “値の出どころ” はここで決め打ちしない（拾えたものだけ）
  const rot =
    metaForSave.rotationState ??
    metaForSave.rotation ??
    (or?.meta?.rotationState ?? or?.meta?.rotation ?? null) ??
    (or?.rotationState ?? or?.rotation ?? null) ??
    null;

  const spinLoop =
    normalizeSpinLoop(ex.spinLoop ?? ex.spin_loop) ??
    normalizeSpinLoop(rot?.spinLoop ?? rot?.loop) ??
    normalizeSpinLoop(metaForSave.spinLoop) ??
    null;

  const descentGate = normalizeDescentGate(
    ex.descentGate ?? ex.descent_gate ?? rot?.descentGate ?? metaForSave.descentGate,
  );

  const depth =
    normalizeDepth(ex.depth ?? ex.nextDepth ?? ex.next_depth) ??
    normalizeDepth(rot?.nextDepth ?? rot?.depth) ??
    normalizeDepth(metaForSave.depth) ??
    null;

  // UIが読む top-level（揺れ吸収）
  metaForSave.spinLoop = spinLoop;
  metaForSave.descentGate = descentGate;
  metaForSave.depth = depth;

  // single shape
  metaForSave.rotationState = {
    spinLoop,
    descentGate,
    depth,
    reason: rot?.reason ?? undefined,
  };
}

/* =========================
 * pastStateNote injection guards (MIN)
 * ========================= */

function isExplicitRecallRequest(textRaw: string): boolean {
  const t = normalizeText(textRaw);
  if (!t) return false;

  return (
    t.includes('思い出して') ||
    t.includes('前回') ||
    t.includes('前の話') ||
    t.includes('さっきの話') ||
    t.includes('先週の') ||
    t.toLowerCase().includes('recall')
  );
}

function shouldSkipPastStateNote(args: PostProcessReplyArgs, metaForSave: any): boolean {
  const requestedMode = String(args.requestedMode ?? metaForSave?.mode ?? '')
    .trim()
    .toLowerCase();

  if (metaForSave?.skipMemory === true) return true;
  if (metaForSave?.goalRecallOnly === true) return true;
  if (metaForSave?.achievementSummaryOnly === true) return true;
  if (requestedMode === 'recall') return true;

  // explicit じゃない時は基本スキップ（注入事故防止）
  if (!isExplicitRecallRequest(args.userText)) return true;

  return false;
}

/* =========================
 * slotPlan utilities (postprocess-local)
 * ========================= */

function pickSlotPlanInfo(
  metaForSave: any,
  orchResult: any,
): { slotPlanLen: number | null; hasSlots: boolean } {
  const candidates = [
    metaForSave?.framePlan,
    metaForSave?.extra?.framePlan,
    orchResult?.framePlan,
    orchResult?.meta?.framePlan,
    orchResult?.slotPlan,
    orchResult?.meta?.slotPlan,
  ];

  for (const c of candidates) {
    if (!c || typeof c !== 'object') continue;

    // framePlan.slots: “slots プロパティがあるか” を hasSlots とする（[] でも true）
    if (Object.prototype.hasOwnProperty.call(c as any, 'slots')) {
      const slots = (c as any).slots;
      if (Array.isArray(slots)) {
        const len = slots.length;
        return { slotPlanLen: len, hasSlots: true };
      }
      // slots が配列でないなら、この候補は無効
    }

    // slotPlan (array)
    if (Array.isArray(c)) {
      const len = c.length;
      return { slotPlanLen: len, hasSlots: true };
    }
  }

  return { slotPlanLen: null, hasSlots: false };
}

function pickSlotPlanArray(metaForSave: any, orchResult: any): any[] {
  const candidates = [
    (orchResult as any)?.slotPlan,
    (orchResult as any)?.framePlan?.slots,
    (metaForSave as any)?.framePlan?.slots,
    (metaForSave as any)?.extra?.slotPlan,
    (metaForSave as any)?.extra?.framePlan?.slots,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c; // ✅ 空配列でも返す（存在が重要）
  }
  return [];
}

function renderSlotPlanText(slotPlan: any[]): string {
  const lines: string[] = [];

  for (const s of slotPlan ?? []) {
    if (s == null) continue;

    if (typeof s === 'string') {
      const t = s.trim();
      if (t) lines.push(t);
      continue;
    }

    const content =
      typeof (s as any).content === 'string' ? (s as any).content.trim() : '';
    const text = typeof (s as any).text === 'string' ? (s as any).text.trim() : '';
    const lns = Array.isArray((s as any).lines) ? (s as any).lines : null;

    if (content) lines.push(content);
    else if (text) lines.push(text);
    else if (lns) {
      for (const l of lns) {
        const tt = String(l ?? '').trim();
        if (tt) lines.push(tt);
      }
    }
  }

  return lines.join('\n').trim();
}

/* =========================
 * main
 * ========================= */

export async function postProcessReply(
  args: PostProcessReplyArgs,
): Promise<PostProcessReplyOutput> {
  const { orchResult, supabase, userCode, userText, conversationId } = args;

  // 1) 本文抽出（まずは Orchestrator/Writer の決定を尊重）
  let finalAssistantText = extractAssistantText(orchResult);

  // 2) metaForSave clone
  const metaRaw =
    orchResult && typeof orchResult === 'object' && (orchResult as any).meta
      ? (orchResult as any).meta
      : null;

  const metaForSave: any = metaRaw && typeof metaRaw === 'object' ? { ...metaRaw } : {};

  // extra は必ず存在
  metaForSave.extra = metaForSave.extra ?? {};

  // 3) intentAnchor 検疫
  sanitizeIntentAnchor(metaForSave);

  // 4) rotationState 形だけ固定
  try {
    ensureRotationState(metaForSave, orchResult);
  } catch (e) {
    console.warn('[IROS/PostProcess] ensureRotationState failed', e);
  }

  // 5) pastStateNote（明示リコール要求だけ）
  if (shouldSkipPastStateNote(args, metaForSave)) {
    metaForSave.extra.pastStateNoteText = null;
    metaForSave.extra.pastStateTriggerKind = null;
    metaForSave.extra.pastStateKeyword = null;
  } else {
    try {
      const topicLabel =
        typeof args.topicLabel === 'string'
          ? args.topicLabel
          : metaForSave?.situation_topic ??
            metaForSave?.situationTopic ??
            metaForSave?.topicLabel ??
            null;

      const limit =
        typeof args.pastStateLimit === 'number' && Number.isFinite(args.pastStateLimit)
          ? args.pastStateLimit
          : 3;

      const forceFallback =
        typeof args.forceRecentTopicFallback === 'boolean'
          ? args.forceRecentTopicFallback
          : Boolean(topicLabel);

      const recall = await preparePastStateNoteForTurn({
        client: supabase,
        supabase,
        userCode,
        userText,
        topicLabel,
        limit,
        forceRecentTopicFallback: forceFallback,
      } as any);

      metaForSave.extra.pastStateNoteText = recall?.pastStateNoteText ?? null;
      metaForSave.extra.pastStateTriggerKind = recall?.triggerKind ?? null;
      metaForSave.extra.pastStateKeyword = recall?.keyword ?? null;
    } catch (e) {
      console.warn('[IROS/PostProcess] pastStateNote inject failed (non-fatal)', e);
      metaForSave.extra.pastStateNoteText = null;
      metaForSave.extra.pastStateTriggerKind = null;
      metaForSave.extra.pastStateKeyword = null;
    }
  }

  // =========================================================
  // 6) ✅ Q1_SUPPRESS沈黙止血：本文は必ず空
  //    + 非SILENCEの空本文 stopgap：通常会話を壊さない
  // =========================================================

  // ✅ 以降で共通利用（宣言はここで1回だけ）
  const allowLLM = getSpeechAllowLLM(metaForSave);

  // 6-A) ✅ Q1_SUPPRESS沈黙止血：本文は必ず空
  try {
    const brakeReason = getBrakeReason(metaForSave);

    const shouldSilenceEmpty =
      brakeReason === 'Q1_SUPPRESS' && allowLLM === false && isEffectivelySilent(finalAssistantText);

    if (shouldSilenceEmpty) {
      finalAssistantText = '';
      metaForSave.extra.silencePatched = true;
      metaForSave.extra.silencePatchedReason = 'Q1_SUPPRESS__NO_LLM__EMPTY_TEXT';
    }
  } catch (e) {
    console.warn('[IROS/PostProcess] silence patch failed (non-fatal)', e);
  }

  // 6-B) ✅ 非SILENCEの空本文 stopgap：通常会話を壊さない
  // - ただし slotPlan がある/LLM_GATE が SKIP_SLOTPLAN のときは「すり替え禁止」
  try {
    const bodyText = String(finalAssistantText ?? '').trim();

    const { slotPlanLen, hasSlots } = pickSlotPlanInfo(metaForSave, orchResult);
    const slotPlanExpected = hasSlots || (typeof slotPlanLen === 'number' && slotPlanLen > 0);

    const isNonSilenceButEmpty =
      allowLLM !== false && bodyText.length === 0 && String(userText ?? '').trim().length > 0;

    // ------------------------------------------------------------
    // ✅ slotPlanExpected なのに本文が空 → slotPlan を commit（v2の本命）
    // - FINAL の slotPlan だけ commit（SCAFFOLD は LLM に渡す）
    // - slotPlanPolicy は PostProcess で上書きしない（Orchestrator を唯一の正）
    // ------------------------------------------------------------
    if (isNonSilenceButEmpty && slotPlanExpected) {
      const slotPlanMaybe = pickSlotPlanArray(metaForSave, orchResult);
      const slotText = renderSlotPlanText(slotPlanMaybe);

      // ✅ policy 検出（UNKNOWN禁止）+ from を確定
      const det = detectSlotPlanPolicy({ metaForSave, orchResult, slotPlanLen, hasSlots });
      const policy: SlotPlanPolicyNorm | null = det.policy;

      console.log('[IROS/PostProcess][SLOTPLAN_POLICY]', {
        conversationId,
        userCode,
        slotPlanPolicy_detected: policy,
        slotPlanPolicy_from: det.from,
        slotPlanPolicy_raw: det.raw,
        slotPlanLen,
        hasSlots,
      });

      if (slotText.trim().length === 0) {
        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalTextPolicy: 'SLOTPLAN_EXPECTED__SLOT_TEXT_EMPTY__SKIP_COMMIT',
          slotPlanPolicy_detected: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen_detected: slotPlanLen,
          hasSlots_detected: hasSlots,
        };

        console.log('[IROS/PostProcess] SLOTPLAN_EXPECTED but SLOT_TEXT_EMPTY (skip commit)', {
          conversationId,
          userCode,
          slotPlanPolicy: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen,
          hasSlots,
        });
      } else if (!shouldCommitSlotPlanFinalOnly({ policy, slotText })) {
        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalTextPolicy: 'EMPTY_BUT_SLOTPLAN_EXPECTED__NONFINAL_SKIP_COMMIT',
          slotPlanPolicy_detected: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen_detected: slotPlanLen,
          hasSlots_detected: hasSlots,
        };

        console.log('[IROS/PostProcess] SLOTPLAN_EXPECTED but NONFINAL (skip commit)', {
          conversationId,
          userCode,
          slotPlanPolicy: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen,
          hasSlots,
        });
      } else {
        // ✅ FINAL のときだけ commit
        finalAssistantText = slotText;

        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalTextPolicy: 'SLOTPLAN_COMMIT',
          slotPlanCommitted: true,
          slotPlanCommittedLen: slotText.length,
          slotPlanPolicy_detected: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen_detected: slotPlanLen,
          hasSlots_detected: hasSlots,
        };

        console.log('[IROS/PostProcess] SLOTPLAN_COMMIT', {
          conversationId,
          userCode,
          slotPlanPolicy: policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen,
          hasSlots,
          len: slotText.length,
          head: slotText.slice(0, 48),
        });
      }
    }

    // ✅ slotPlanExpected じゃない「空」だけ ACK_FALLBACK
    else if (isNonSilenceButEmpty && !slotPlanExpected) {
      const callName =
        metaForSave?.userProfile?.user_call_name ??
        metaForSave?.extra?.userProfile?.user_call_name ??
        'orion';

      const u = String(userText ?? '').replace(/\s+/g, ' ').trim();
      const ul = u.toLowerCase();

      const looksLikeGreeting =
        ul === 'こんにちは' ||
        ul === 'こんばんは' ||
        ul === 'おはよう' ||
        ul.includes('はじめまして') ||
        ul.includes('よろしく');

      finalAssistantText = looksLikeGreeting ? `こんにちは、${callName}さん。🪔` : 'うん、届きました。🪔';

      metaForSave.extra = {
        ...(metaForSave.extra ?? {}),
        finalTextPolicy: 'ACK_FALLBACK',
        emptyFinalPatched: true,
      };
    }
  } catch (e) {
    console.warn('[IROS/PostProcess] non-silence empty patch failed', e);
  }

  // =========================================================
  // ✅ extractedTextFromModel / rawTextFromModel の同期は “最後に1回だけ”
  // - extractedTextFromModel: 常に最終本文
  // - rawTextFromModel: 空で上書き禁止（prev が空で final が非空なら救済で入れる）
  // =========================================================
  {
    const finalText = String(finalAssistantText ?? '').trim();
    const prevRaw = String((metaForSave.extra as any).rawTextFromModel ?? '').trim();

    (metaForSave.extra as any).extractedTextFromModel = finalText;

    if (prevRaw.length === 0 && finalText.length > 0) {
      (metaForSave.extra as any).rawTextFromModel = finalText;
    }
  }

  // 7) UnifiedAnalysis 保存（失敗しても落とさない）
  try {
    const tenantId = typeof args.tenantId === 'string' ? args.tenantId : 'default';

    const analysis = await buildUnifiedAnalysis({
      userText,
      assistantText: finalAssistantText,
      meta: metaForSave,
    });

    await saveUnifiedAnalysisInline(supabase, analysis, {
      userCode,
      tenantId,
      agent: 'iros',
    });

    await applyAnalysisToLastUserMessage({
      supabase,
      conversationId,
      analysis,
    });
  } catch (e) {
    console.error('[UnifiedAnalysis] save failed (non-fatal)', {
      userCode,
      conversationId,
      error: e,
    });
  }

  return { assistantText: finalAssistantText, metaForSave };
}
