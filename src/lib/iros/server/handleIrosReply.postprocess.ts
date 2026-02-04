// file: src/lib/iros/server/handleIrosReply.postprocess.ts
// iros - Postprocess (MIN)
// 目的：
// - orchResult から assistantText / metaForSave を確定
// - intentAnchor の検疫（汚染防止）
// - rotationState を「UIが読む最低限」に正規化（値は変えず、形だけ固定）
// - Q1_SUPPRESS + allowLLM=false + 無発話 → 本文は必ず空（沈黙止血）
// - pastStateNote 注入（条件一致のみ）
// - UnifiedAnalysis の保存（失敗しても返信は落とさない）
//
// 【憲法準拠ポイント】
// - 正本は meta.framePlan のみ（extra.framePlan を参照しない）
// - slotPlanPolicy を postprocess で推定/上書きしない（Orchestrator/判断レイヤーが唯一の正）
// - SA_OK（= meta.extra.saDecision === 'OK'）かつ FINAL のとき、writerHints を注入（不足時のみの保険）
// - 本文 commit は「allowLLM=false で writer を呼べない」等の必要時に限定し、通常は LLM(writer) に回す

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

function getSaDecision(meta: any): string | null {
  const ex = getExtra(meta);
  const v =
    ex.saDecision ??
    ex.sa_decision ??
    meta?.saDecision ??
    meta?.sa_decision ??
    null;
  return typeof v === 'string' ? v.trim().toUpperCase() : null;
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
 * slotPlanPolicy (read-only)
 * - postprocess では推定/上書きしない
 * - 正本は meta.framePlan.slotPlanPolicy（または meta.slotPlanPolicy）に限定
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

function readSlotPlanPolicy(metaForSave: any): { policy: SlotPlanPolicyNorm | null; from: string; raw: unknown } {
  const candidates: Array<[string, unknown]> = [
    ['metaForSave.framePlan.slotPlanPolicy', metaForSave?.framePlan?.slotPlanPolicy],
    ['metaForSave.slotPlanPolicy', metaForSave?.slotPlanPolicy],
    // ✅ extra.slotPlanPolicy は正本ではないので参照しない（憲法：正本一本化）
  ];

  for (const [from, raw] of candidates) {
    const p = normSlotPlanPolicy(raw);
    if (p) return { policy: p, from, raw };
  }
  return { policy: null, from: 'none', raw: null };
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
 * - 正本は metaForSave.framePlan のみ
 * ========================= */

function pickSlotPlanLenAndPresence(metaForSave: any): { slotPlanLen: number | null; hasSlots: boolean } {
  const fp = metaForSave?.framePlan;
  if (fp && typeof fp === 'object' && Object.prototype.hasOwnProperty.call(fp, 'slots')) {
    const slots = (fp as any).slots;
    if (Array.isArray(slots)) return { slotPlanLen: slots.length, hasSlots: true };
  }
  return { slotPlanLen: null, hasSlots: false };
}

function pickSlotPlanArray(metaForSave: any): any[] {
  const fp = metaForSave?.framePlan;
  const slots = fp && typeof fp === 'object' ? (fp as any).slots : null;
  return Array.isArray(slots) ? slots : [];
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

    const content = typeof (s as any).content === 'string' ? (s as any).content.trim() : '';
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
 * writerHints injection (MIN, backup only)
 * - handleIrosReply 側が主担当だが、欠損時の保険として postprocess でも刻む
 * ========================= */

type WriterHints = {
  final?: boolean;
  allowAssertive?: boolean;
  avoidHedge?: boolean;
  avoidQuestions?: boolean;
};

function ensureWriterHints(metaForSave: any, args: { conversationId: string; userCode: string }): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;

  const ex = getExtra(metaForSave);
  const { policy } = readSlotPlanPolicy(metaForSave);

  // ✅ 解放条件（憲法A）
  // - 判定源: meta.framePlan.slotPlanPolicy === 'FINAL'
  // - 解放条件: meta.extra.saDecision === 'OK'（既存SA判定を正）
  const sa = getSaDecision(metaForSave);
  const assertOk = policy === 'FINAL' && sa === 'OK';

  // 既に上位で入っているなら尊重（上書きしない）
  const current = (ex.writerHints && typeof ex.writerHints === 'object') ? (ex.writerHints as WriterHints) : null;

  if (!assertOk) return;

  const next: WriterHints = {
    final: true,
    allowAssertive: true,
    avoidHedge: true,
    avoidQuestions: true,
    ...(current ?? {}),
  };

  // 欠損補完のみ
  metaForSave.extra = metaForSave.extra ?? {};
  metaForSave.extra.writerHints = next;

  // 監査ログ（憲法E）
  try {
    console.log('[IROS/FINAL/ASSERTIVE_ALLOWED]', {
      conversationId: args.conversationId,
      userCode: args.userCode,
      slotPlanPolicy: policy,
      saDecision: sa,
      writerHints: next,
    });
  } catch {}
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

  // ✅ 正本一本化（D）
  // - render/後段の唯一の正は metaForSave.framePlan
  // - orchResult.framePlan からの転写は「欠損補完（形だけ）」のみ
  if (metaForSave.framePlan == null) {
    const orFp = orchResult && typeof orchResult === 'object' ? (orchResult as any).framePlan : null;
    if (orFp && typeof orFp === 'object') {
      metaForSave.framePlan = { ...orFp };
    }
  }

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
  //    + 非無言アクトの空本文 stopgap：通常会話を壊さない
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

  // 6-B) ✅ 非無言アクトの空本文 stopgap（ただし憲法準拠で “seed→writer” を優先）
  try {
    const bodyText = String(finalAssistantText ?? '').trim();

    // ✅ meta.framePlan（正本）だけを見る
    {
      const info = pickSlotPlanLenAndPresence(metaForSave);
      slotPlanLen = info.slotPlanLen;
      hasSlots = info.hasSlots;
    }

    slotPlanExpected = hasSlots || (typeof slotPlanLen === 'number' && slotPlanLen > 0);

    // ✅ 非無言アクトの空本文 stopgap
    // - 無言アクト/FORWARD は silencePolicy 側で扱う（ここでは触らない）
    const ex2 = getExtra(metaForSave);
    const speechActNow = String(ex2.speechAct ?? (metaForSave as any)?.speechAct ?? '')
      .trim()
      .toUpperCase();

    const isSpeechSilenceLike =
      speechActNow === '無言アクト' ||
      speechActNow === 'FORWARD' ||
      ex2.speechSkipped === true ||
      ex2.renderEngineSilenceBypass === true ||
      ex2.renderEngineForwardBypass === true;

    isNonSilenceButEmpty =
      !isSpeechSilenceLike &&
      bodyText.length === 0 &&
      String(userText ?? '').trim().length > 0;


    // ------------------------------------------------------------
    // ✅ slotPlanExpected なのに本文が空
    // - 憲法方針：通常は seed を作って writer（LLM）に回す
    // - 例外：allowLLM=false（writer を呼べない）時は deterministic に commit して会話停止を防ぐ
    // ------------------------------------------------------------
    if (isNonSilenceButEmpty && slotPlanExpected) {
      const slotPlanMaybe = pickSlotPlanArray(metaForSave);
      const slotText = renderSlotPlanText(slotPlanMaybe);

      const det = readSlotPlanPolicy(metaForSave);

      console.log('[IROS/PostProcess][SLOTPLAN_POLICY]', {
        conversationId,
        userCode,
        slotPlanPolicy_detected: det.policy,
        slotPlanPolicy_from: det.from,
        slotPlanPolicy_raw: det.raw,
        slotPlanLen,
        hasSlots,
      });

      if (slotText.trim().length === 0) {
        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalTextPolicy: 'SLOTPLAN_EXPECTED__SLOT_TEXT_EMPTY__SKIP_COMMIT',
          slotPlanPolicy_detected: det.policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen_detected: slotPlanLen,
          hasSlots_detected: hasSlots,
        };

        console.log('[IROS/PostProcess] SLOTPLAN_EXPECTED but SLOT_TEXT_EMPTY (skip)', {
          conversationId,
          userCode,
          slotPlanPolicy: det.policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen,
          hasSlots,
        });
      } else {
        // ✅ slotText の浄化（内部マーカー @OBS/@SHIFT 等を落とす）
        // 目的：
        // - cleanedLen=0 → 本文"……"化の根を断つ
        // - seed には @OBS/@SHIFT を残してOK。ただし「露出OKの核1行」を必ず混ぜる
        const slotTextStr = String(slotText ?? '').trim();

        // 露出OKの核：まずは userText をそのまま1行（deterministic / 憶測なし）
        const coreLine = String(userText ?? '').replace(/\s+/g, ' ').trim();


// ✅ seed（writerへ）:
// - 目的：clean後が極小（例: 13文字）になる状態を避ける
// - 方針：核（coreLine）は「生行」では混ぜない。@SEED_TEXT として混ぜて “cleaned=0” を維持する
const seedForWriter = (() => {
  const base = String(slotTextStr ?? '');

  const core = String(coreLine ?? '').trim();
  if (!core) return base;

  const rawLines0 = base.split('\n');
  const cleanedLines0 = rawLines0
    .map((l) => String(l ?? '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('@'));
  const cleaned0 = cleanedLines0.join('\n').trim();

  // ✅ 閾値：cleaned が短いと writer seed が薄くなる（今回: 13）
  const CLEAN_MIN = 48;

  // 既に coreLine 相当が含まれているなら二重に入れない
  // ※ 生行としては混ぜないので、@SEED_TEXT の JSON に入った core を検出する
  const coreEscapedForJson = core.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const alreadyHasCore =
    base.includes(`"text":"${coreEscapedForJson}"`) || cleaned0.includes(core);

  if (alreadyHasCore) return base;

  if (cleaned0.length < CLEAN_MIN) {
    // core は「露出OKの生行」を1行だけ混ぜる（@ではない）
    // 目的：cleanedSlotText を >0 にして emptyLikeNow を回避する
    const seedLine = `@SEED_TEXT ${JSON.stringify({ text: core })}`;
    return `${base}\n${core}\n${seedLine}`.trim();
  }


  return base;
})();

const rawLines = String(seedForWriter ?? '').split('\n');
const cleanedLines = rawLines
  .map((l) => String(l ?? '').trim())
  .filter((l) => l.length > 0 && !l.startsWith('@'));
const cleanedSlotText = cleanedLines.join('\n').trim();

const hadInternalMarkers = /(^|\n)\s*@/m.test(seedForWriter);
const cleanedApplied = hadInternalMarkers && cleanedSlotText.length !== seedForWriter.length;

// ✅ 観測ログ（seedForWriter / cleanedSlotText 確定後なのでTS安全）
{
  const core = String(coreLine ?? '').trim();
  console.log('[IROS/PostProcess][SEED_CORE]', {
    coreLineLen: core.length,
    seedHasCore: core ? seedForWriter.includes(core) : false,
    seedLen: seedForWriter.length,
    cleanedLen: cleanedSlotText.length,
    cleanedApplied,
    hadInternalMarkers,
  });
}


        // ✅ LLMへ渡す seed を保存（writerへ）
        // - @Q_SLOT / @OBS などの内部ラッパが混入すると writer の seedDraftHead に出てしまうため
        //   ここで “本文seed” に正規化して保存する
        function sanitizeLlmRewriteSeed(seedRaw: unknown): string {
          const s = String(seedRaw ?? '').trim();
          if (!s) return '';

          const parts: string[] = [];

          // 0) 行ベースで拾う（正規表現より安全：JSON内に } が入っても壊れにくい）
          const lines = s.split('\n');

          for (const line0 of lines) {
            const line = String(line0 ?? '').trim();
            if (!line) continue;

            // ✅ @SEED_TEXT {"text":"..."} を拾う（coreLine）
            if (line.startsWith('@SEED_TEXT ')) {
              const json = line.slice('@SEED_TEXT '.length).trim();
              try {
                const obj = JSON.parse(json);
                const t = String(obj?.text ?? obj?.content ?? '').trim();
                if (t) parts.push(t);
              } catch {
                // ignore
              }
              continue;
            }

            // 1) @Q_SLOT {...} を拾って seed_text / content を抜く
            if (line.startsWith('@Q_SLOT ')) {
              const json = line.slice('@Q_SLOT '.length).trim();
              try {
                const obj = JSON.parse(json);
                const t = String(obj?.seed_text ?? obj?.seedText ?? obj?.content ?? obj?.text ?? '').trim();
                if (t) parts.push(t);
              } catch {
                // ignore
              }
              continue;
            }
          }

          // 取れたら重複を軽く落として返す
          if (parts.length > 0) {
            const uniq: string[] = [];
            const seen = new Set<string>();
            for (const p of parts) {
              const t = String(p ?? '').trim();
              if (!t) continue;
              if (seen.has(t)) continue;
              seen.add(t);
              uniq.push(t);
            }
            return uniq.join('\n').trim();
          }

          // 2) @OBS {...} なら user を抜く（単体行のケース）
          const mObs = s.match(/^@OBS\s+(\{.*\})\s*$/s);
          if (mObs) {
            try {
              const obj = JSON.parse(mObs[1]);
              const t = String(obj?.user ?? obj?.text ?? '').trim();
              if (t) return t;
            } catch {
              // ignore
            }
          }

          // 3) 最後の保険：@で始まる行（内部マーカー）を落としてプレーン化
          const plain = s
            .split('\n')
            .map((x) => String(x ?? '').trimEnd())
            .filter((line) => line.trim().length > 0 && !line.trim().startsWith('@'))
            .join('\n')
            .trim();

          return plain;
        }

        const seedForWriterRaw = seedForWriter;
        const seedForWriterSanitized = sanitizeLlmRewriteSeed(seedForWriterRaw);

        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          slotPlanPolicy_detected: det.policy,
          slotPlanPolicy_from: det.from,
          slotPlanLen_detected: slotPlanLen,
          hasSlots_detected: hasSlots,

          slotTextHadInternalMarkers: hadInternalMarkers,
          slotTextCleanedApplied: cleanedApplied,
          slotTextRawLen: seedForWriter.length,
          slotTextCleanedLen: cleanedSlotText.length,
          slotTextDroppedLines: Math.max(0, rawLines.length - cleanedLines.length),

          // ✅ seed 保存（writerへ）
          llmRewriteSeed: seedForWriterSanitized,
          llmRewriteSeedRaw: seedForWriterRaw, // デバッグ用（必要なら後で消す）
          llmRewriteSeedFrom: 'postprocess(slotPlan->writer-seed)',
          llmRewriteSeedAt: new Date().toISOString(),
        };

// ✅ allowLLM=false のときだけ deterministic commit（会話停止を防ぐ）
// - それ以外は本文をここで作らず、writerへ回す（憲法の「航海士」）
if (allowLLM === false) {
  // commit 用の本文は “cleaned” だけに依存しない（@行のみだと空になり得る）
  // - seedForWriterSanitized は @SEED_TEXT / @Q_SLOT 由来の本文を抽出済み
  // - 最後に coreLine（ユーザー原文1行）へフォールバック
  const commitText =
    String(seedForWriterSanitized ?? '').trim() ||
    String(cleanedSlotText ?? '').trim() ||
    String(coreLine ?? '').trim() ||
    '';

  finalAssistantText = commitText;

  metaForSave.extra = {
    ...(metaForSave.extra ?? {}),
    finalTextPolicy: 'SLOTPLAN_COMMIT_FINAL__NO_LLM',
    slotPlanCommitted: true,
    slotPlanCommittedLen: commitText.length,
  };

  console.log('[IROS/PostProcess] SLOTPLAN_COMMIT_FINAL__NO_LLM', {
    conversationId,
    userCode,
    slotPlanPolicy: det.policy,
    slotPlanPolicy_from: det.from,
    slotPlanLen,
    hasSlots,
    head: commitText.slice(0, 64),
  });

} else {
  // ✅ writer に本文生成させる（FINAL__LLM_COMMIT）: ただし base は空にしない
  // - base が空だと下流で "……"(len=2) に落ちるため、最低1行だけ可視テキストを残す
  // - seed / policy は維持し、writer は通常通り走る
  const baseVisible =
    String(coreLine ?? '').trim() ||
    String(cleanedSlotText ?? '').trim() ||
    '';

  finalAssistantText = baseVisible;

  metaForSave.extra = {
    ...(metaForSave.extra ?? {}),
    finalTextPolicy: 'FINAL__LLM_COMMIT',
    slotPlanCommitted: false,
    baseVisibleLen: baseVisible.length,
    baseVisibleHead: baseVisible.slice(0, 64),
  };

  console.log('[IROS/PostProcess] SLOTPLAN_SEED_TO_WRITER (base visible)', {
    conversationId,
    userCode,
    slotPlanPolicy: det.policy,
    slotPlanPolicy_from: det.from,
    slotPlanLen,
    hasSlots,
    baseVisibleLen: baseVisible.length,
    baseVisibleHead: baseVisible.slice(0, 48),
    seedLen: String(slotText ?? '').length,
    seedHead: String(slotText ?? '').slice(0, 48),
  });
}
      }
    } else if (isNonSilenceButEmpty && !slotPlanExpected) {
      // ✅ seed があるなら ACK_FALLBACK で潰さない
      const fp = String((metaForSave.extra as any)?.finalTextPolicy ?? '').trim();
      const seed = String((metaForSave.extra as any)?.llmRewriteSeed ?? '').trim();
      const hasSeed = seed.length > 0;

      if (fp === 'FINAL__LLM_COMMIT' || hasSeed) {
        console.log('[IROS/PostProcess] ACK_FALLBACK skipped (seed present)', {
          conversationId,
          userCode,
          finalTextPolicy: fp,
          seedLen: seed.length,
        });
      } else {
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
    }
  } catch (e) {
    console.warn('[IROS/PostProcess] non-silence empty patch failed', e);
  }

  // =========================================================
  // ✅ writerHints の欠損補完（憲法A/B/E）
  // - handleIrosReply が主担当だが、欠損時だけ postprocess で注入
  // =========================================================
  try {
    ensureWriterHints(metaForSave, { conversationId, userCode });
  } catch (e) {
    console.warn('[IROS/PostProcess] ensureWriterHints failed (non-fatal)', e);
  }

  // ✅ extractedTextFromModel / rawTextFromModel の同期は “最後に1回だけ”
  // - extractedTextFromModel: 常に最終本文
  // - rawTextFromModel: 空で上書き禁止（prev が空で final が非空なら救済で入れる）
  // 重要:
  // - UI は renderGateway で rephraseBlocks を採用するが、
  //   postprocess 側の finalAssistantText が '……' に固定されるケースがある。
  // - その場合は blocks/head から “可視本文” を救済して同期する（本文単一ソースの整合）。
  if (metaForSave && typeof metaForSave === 'object') {
    metaForSave.extra = (metaForSave as any).extra ?? {};
    const ex: any = (metaForSave as any).extra;

    const isDotsOnlyLocal = (t0: unknown) => {
      const t = String(t0 ?? '').trim();
      return t === '…' || t === '...' || t === '……';
    };

    const pickFromRephrase = () => {
      const head = String(ex?.rephraseHead ?? '').trim();
      if (head && !isDotsOnlyLocal(head)) return head;

      const blocks = ex?.rephraseBlocks;
      if (!Array.isArray(blocks) || blocks.length === 0) return '';

      // blocks は UI で採用される可視本文候補。長すぎない範囲で結合。
      const joined = blocks
        .map((b: any) => String(b ?? '').trim())
        .filter((s: string) => s && !isDotsOnlyLocal(s))
        .slice(0, 3)
        .join('\n')
        .trim();

      return joined;
    };

    // --- (A) finalAssistantText が点/空なら、rephraseBlocks/head から救済して “最終本文” を揃える
    const cur = String(finalAssistantText ?? '').trim();
    if (!cur || isDotsOnlyLocal(cur)) {
      const rescued = pickFromRephrase();
      if (rescued) {
        finalAssistantText = rescued;
        ex.finalAssistantTextRescuedFromRephrase = true;
      }
    }

    // --- (B) 同期（ここから先は “最終本文” を使う）
    const finalText = String(finalAssistantText ?? '').trim();
    const prevRaw = String(ex?.rawTextFromModel ?? '').trim();

    ex.extractedTextFromModel = finalText;

    // rawTextFromModel は「空で上書き禁止」：空なら入れない。prev が空で final が非空なら救済で入れる
    if (!prevRaw && finalText) {
      ex.rawTextFromModel = finalText;
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
