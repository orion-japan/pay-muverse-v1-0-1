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
 * slotPlanPolicy detect + source
 * - UNKNOWN を握りつぶさない（見えたら UNKNOWN のまま保持）
 * - ただし commit 判定では「UNKNOWN/null は FINAL 扱い」に倒すための下準備をする
 * - 見つからない場合：
 *    - slots が scaffold っぽければ SCAFFOLD
 *    - それ以外で slots があれば FINAL（デフォルト）
 * ========================= */

type SlotPlanPolicyNorm = 'SCAFFOLD' | 'FINAL' | 'UNKNOWN';

function normSlotPlanPolicy(v: unknown): SlotPlanPolicyNorm | null {
  if (typeof v !== 'string') return null;

  const s = v.trim().toUpperCase();
  if (s === 'SCAFFOLD') return 'SCAFFOLD';
  if (s === 'FINAL') return 'FINAL';
  if (s === 'UNKNOWN') return 'UNKNOWN';

  return null;
}

function detectSlotPlanPolicy(args: {
  metaForSave?: any;
  orchResult?: any;
  slotPlanLen?: number | null;
  hasSlots?: boolean | null;
}): { policy: SlotPlanPolicyNorm; from: string; raw: unknown } {
  const metaForSave = args.metaForSave ?? null;
  const orchResult = args.orchResult ?? null;

  const candidates: Array<[string, unknown]> = [
    // meta 側
    ['metaForSave.framePlan.slotPlanPolicy', metaForSave?.framePlan?.slotPlanPolicy],
    ['metaForSave.slotPlanPolicy', metaForSave?.slotPlanPolicy],
    ['metaForSave.extra.slotPlanPolicy', metaForSave?.extra?.slotPlanPolicy],

    // orchResult 側
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
    Boolean(slotsA ?? slotsB ?? slotsC); // 「slots プロパティがあるか」を優先（[] でも true）

  const pickSlots = (): any[] | null => {
    if (Array.isArray(slotsA)) return slotsA;
    if (Array.isArray(slotsB)) return slotsB;
    if (Array.isArray(slotsC)) return slotsC;
    return null;
  };

  const looksLikeScaffold = (slots: any[] | null): boolean => {
    if (!Array.isArray(slots) || slots.length === 0) return false;
    return slots.some((s) => {
      const k = String(s?.key ?? '').toUpperCase();
      return (
        k.startsWith('FLAG_') ||
        k.includes('ONE_POINT') ||
        k.includes('SCAFFOLD') ||
        k === 'FLAG_PREFACE' ||
        k === 'FLAG_PURPOSE' ||
        k === 'FLAG_POINTS_3'
      );
    });
  };

  // slots があるなら「scaffoldっぽいか」で分岐
  if (hasSlots && slotPlanLen > 0) {
    const slotsPicked = pickSlots();
    if (looksLikeScaffold(slotsPicked)) {
      const policy: SlotPlanPolicyNorm = 'SCAFFOLD';
      if (metaForSave?.framePlan && metaForSave.framePlan.slotPlanPolicy == null) {
        metaForSave.framePlan = { ...metaForSave.framePlan, slotPlanPolicy: policy };
      }
      if (metaForSave && metaForSave.slotPlanPolicy == null) {
        metaForSave.slotPlanPolicy = policy;
      }
      return { policy, from: 'inferred(scaffold-like-slots)', raw: null };
    }

    // ✅ それ以外は FINAL をデフォルト（ここが今回の肝）
    const policy: SlotPlanPolicyNorm = 'FINAL';
    if (metaForSave?.framePlan && metaForSave.framePlan.slotPlanPolicy == null) {
      metaForSave.framePlan = { ...metaForSave.framePlan, slotPlanPolicy: policy };
    }
    if (metaForSave && metaForSave.slotPlanPolicy == null) {
      metaForSave.slotPlanPolicy = policy;
    }
    return { policy, from: 'default(has-slots->FINAL)', raw: null };
  }

  // slots が無いなら UNKNOWN（ただし後段は text の有無で処理される）
  return { policy: 'UNKNOWN', from: 'none', raw: null };
}


function shouldCommitSlotPlanFinalOnly(args: {
  policy: SlotPlanPolicyNorm | null;
  slotText: string;
}): boolean {
  const textOk = String(args.slotText ?? '').trim().length > 0;

  // ✅ commit しないのは SCAFFOLD だけ（PDF準拠）
  // - UNKNOWN/null は「scaffold判定できていない」なので、normalChat等の slots を本文として commit する
  if (args.policy === 'SCAFFOLD') return false;

  return textOk;
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

  // ✅ 6-B の値を catch 後やログで参照しても壊れないように、外で宣言しておく
  let slotPlanLen: number | null = null;
  let hasSlots: boolean = false;
  let slotPlanExpected = false;
  let isNonSilenceButEmpty = false;

  // 6-A) ✅ Q1_SUPPRESS沈黙止血：本文は必ず空
  try {
    const brakeReason = getBrakeReason(metaForSave);

    const shouldSilenceEmpty =
      brakeReason === 'Q1_SUPPRESS' &&
      allowLLM === false &&
      isEffectivelySilent(finalAssistantText);

    if (shouldSilenceEmpty) {
      finalAssistantText = '';
      metaForSave.extra = metaForSave.extra ?? {};
      metaForSave.extra.silencePatched = true;
      metaForSave.extra.silencePatchedReason = 'Q1_SUPPRESS__NO_LLM__EMPTY_TEXT';
    }
  } catch (e) {
    console.warn('[IROS/PostProcess] silence patch failed (non-fatal)', e);
  }

  // 6-B) ✅ 非SILENCEの空本文 stopgap：通常会話を壊さない
  // - ただし slotPlan がある/slotPlanExpected のときは「すり替え禁止」
  try {
    const bodyText = String(finalAssistantText ?? '').trim();

    // ✅ ここで確定した値を外の変数へ
    {
      const info = pickSlotPlanInfo(metaForSave, orchResult);
      slotPlanLen = info.slotPlanLen;
      hasSlots = info.hasSlots;
    }

    slotPlanExpected = hasSlots || (typeof slotPlanLen === 'number' && slotPlanLen > 0);

    isNonSilenceButEmpty =
      allowLLM !== false &&
      bodyText.length === 0 &&
      String(userText ?? '').trim().length > 0;

    // ------------------------------------------------------------
    // ✅ slotPlanExpected なのに本文が空 → slotPlan を処理（v2の本命）
    // - FINAL の slotPlan だけ commit（本文に採用）
    // - SCAFFOLD は LLM に渡す seed として保存（本文は作らない＝PDF準拠）
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
      } else if (policy === 'FINAL') {
        // ✅ FINAL：通常は slotPlan を本文に採用（commit OK）
        // ただし slotText が @OBS/@SHIFT など「内部マーカー」を含む場合は本文として不正なので浄化する

        const isIrDiagnosisTurn =
          (metaForSave as any)?.isIrDiagnosisTurn === true ||
          String((metaForSave as any)?.mode ?? '').toLowerCase() === 'diagnosis' ||
          String((metaForSave as any)?.presentationKind ?? '').toLowerCase() === 'diagnosis' ||
          (metaForSave as any)?.framePlan?.isIrDiagnosisTurn === true ||
          String((metaForSave as any)?.framePlan?.mode ?? '').toLowerCase() === 'diagnosis';

        // ✅ slotText の本文化：行頭 @ を落とす（@OBS/@SHIFT/@NEXT 等）
        const rawLines = String(slotText ?? '').split('\n');
        const cleanedLines = rawLines
          .map((l) => String(l ?? '').trim())
          .filter((l) => l.length > 0 && !l.startsWith('@'));
        const cleanedSlotText = cleanedLines.join('\n').trim();

        const hadInternalMarkers = /(^|\n)\s*@/m.test(String(slotText ?? ''));
        const cleanedApplied = hadInternalMarkers && cleanedSlotText.length !== String(slotText ?? '').trim().length;

        if (cleanedSlotText.length === 0) {
          // ✅ 本文として成立しない（内部行しかない）→ 空commit禁止：ACKへ
          const callName =
            metaForSave?.userProfile?.user_call_name ??
            (metaForSave.extra as any)?.userProfile?.user_call_name ??
            'orion';

          finalAssistantText = `うん、届きました。🪔`;

          metaForSave.extra = {
            ...(metaForSave.extra ?? {}),
            finalTextPolicy: isIrDiagnosisTurn
              ? 'DIAGNOSIS_FINAL__SLOT_TEXT_INTERNAL_ONLY__ACK_FALLBACK'
              : 'SLOTPLAN_FINAL__SLOT_TEXT_INTERNAL_ONLY__ACK_FALLBACK',
            slotPlanCommitted: false,
            slotPlanCommittedLen: 0,
            slotPlanPolicy_detected: policy,
            slotPlanPolicy_from: det.from,
            slotPlanLen_detected: slotPlanLen,
            hasSlots_detected: hasSlots,
            slotTextHadInternalMarkers: hadInternalMarkers,
            slotTextCleanedApplied: cleanedApplied,
            slotTextRawLen: String(slotText ?? '').length,
            slotTextCleanedLen: cleanedSlotText.length,
            slotTextDroppedLines: Math.max(0, rawLines.length - cleanedLines.length),
          };

          console.log('[IROS/PostProcess] SLOTPLAN_FINAL_INTERNAL_ONLY -> ACK_FALLBACK', {
            conversationId,
            userCode,
            isIrDiagnosisTurn,
            slotPlanPolicy: policy,
            slotPlanPolicy_from: det.from,
            slotPlanLen,
            hasSlots,
            hadInternalMarkers,
            rawLen: String(slotText ?? '').length,
            cleanedLen: cleanedSlotText.length,
          });
        } else {
          // ✅ 浄化した本文を commit
          finalAssistantText = cleanedSlotText;

          metaForSave.extra = {
            ...(metaForSave.extra ?? {}),
            finalTextPolicy: isIrDiagnosisTurn
              ? 'DIAGNOSIS_FINAL__COMMIT_SLOT_TEXT_CLEANED'
              : 'SLOTPLAN_COMMIT_FINAL_CLEANED',
            slotPlanCommitted: true,
            slotPlanCommittedLen: cleanedSlotText.length,
            slotPlanPolicy_detected: policy,
            slotPlanPolicy_from: det.from,
            slotPlanLen_detected: slotPlanLen,
            hasSlots_detected: hasSlots,
            slotTextHadInternalMarkers: hadInternalMarkers,
            slotTextCleanedApplied: cleanedApplied,
            slotTextRawLen: String(slotText ?? '').length,
            slotTextCleanedLen: cleanedSlotText.length,
            slotTextDroppedLines: Math.max(0, rawLines.length - cleanedLines.length),
          };

          console.log('[IROS/PostProcess] SLOTPLAN_FINAL_COMMIT_CLEANED', {
            conversationId,
            userCode,
            isIrDiagnosisTurn,
            slotPlanPolicy: policy,
            slotPlanPolicy_from: det.from,
            slotPlanLen,
            hasSlots,
            hadInternalMarkers,
            rawLen: String(slotText ?? '').length,
            cleanedLen: cleanedSlotText.length,
            head: cleanedSlotText.slice(0, 64),
          });
        }
      } else {


// ✅ SCAFFOLD：本文に commit しない（PDF準拠）
// - slotText は「LLMに渡す seed」として保存する
// - 本文は空のまま（この後に LLM writer が本文を生成する）
metaForSave.extra = {
  ...(metaForSave.extra ?? {}),
  finalTextPolicy: 'SLOTPLAN_SEED_SCAFFOLD',
  slotPlanCommitted: false,
  slotPlanSeedLen: slotText.length,
  slotPlanPolicy_detected: policy,
  slotPlanPolicy_from: det.from,
  slotPlanLen_detected: slotPlanLen,
  hasSlots_detected: hasSlots,

  llmRewriteSeed: slotText,
  llmRewriteSeedFrom: 'postprocess(slotPlan:SCAFFOLD)',
  llmRewriteSeedAt: new Date().toISOString(),
};

console.log('[IROS/PostProcess] SLOTPLAN_SEED_SCAFFOLD (no commit)', {
  conversationId,
  userCode,
  slotPlanPolicy: policy,
  slotPlanPolicy_from: det.from,
  slotPlanLen,
  hasSlots,
  seedLen: slotText.length,
  seedHead: slotText.slice(0, 48),
});


        // ✅ ここでは本文を作らない（空のまま）
        // finalAssistantText は変更しない
      }
    } else if (isNonSilenceButEmpty && !slotPlanExpected) {
      // ✅ slotPlanExpected じゃない「空」だけ ACK_FALLBACK
      const callName =
        metaForSave?.userProfile?.user_call_name ??
        (metaForSave.extra as any)?.userProfile?.user_call_name ??
        'orion';

      const u = String(userText ?? '').replace(/\s+/g, ' ').trim();
      const ul = u.toLowerCase();

      const looksLikeGreeting =
        ul === 'こんにちは' ||
        ul === 'こんばんは' ||
        ul === 'おはよう' ||
        ul.includes('はじめまして') ||
        ul.includes('よろしく');

      finalAssistantText = looksLikeGreeting
        ? `こんにちは、${callName}さん。🪔`
        : 'うん、届きました。🪔';

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
    const prevRaw = String((metaForSave.extra as any)?.rawTextFromModel ?? '').trim();

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
