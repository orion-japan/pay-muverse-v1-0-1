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
import { decideExpressionLane } from '@/lib/iros/expression/decideExpressionLane';
import { buildMirrorFlowV1, type PolarityV1 } from '@/lib/iros/mirrorFlow/mirrorFlow.v1';
import { buildExprDirectiveV1 } from '@/lib/iros/expression/exprDirectiveV1';
import {
  buildUnifiedAnalysis,
  saveUnifiedAnalysisInline,
  applyAnalysisToLastUserMessage,
} from './handleIrosReply.analysis';

import {
  canonicalizeIrosMeta,
  applyCanonicalToMetaForSave,
} from '@/lib/iros/server/handleIrosReply.meta';

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

function readSlotPlanPolicy(metaForSave: any): {
  policy: SlotPlanPolicyNorm | null;
  from: string;
  raw: unknown;
} {
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

  metaForSave.spinLoop = spinLoop;
  metaForSave.descentGate = descentGate;
  metaForSave.depth = depth;

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
    if (Array.isArray(slots)) {
      const len = slots.length;
      return { slotPlanLen: len, hasSlots: len > 0 };
    }
    return { slotPlanLen: null, hasSlots: false };
  }
  return { slotPlanLen: null, hasSlots: false };
}

// ✅ slotPlan（本文）優先で拾う（schema-only は除外）
function pickSlotPlanArrayPreferContent(metaForSave: any): any[] {
  const framePlan =
    metaForSave?.framePlan ??
    metaForSave?.meta?.framePlan ??
    metaForSave?.extra?.framePlan ??
    null;

  const raw =
    metaForSave?.slotPlan?.slots ??
    metaForSave?.slotPlan ??
    metaForSave?.meta?.slotPlan?.slots ??
    metaForSave?.meta?.slotPlan ??
    framePlan?.slotPlan?.slots ??
    framePlan?.slotPlan ??
    framePlan?.slots ??
    null;

  const arr: any[] = Array.isArray(raw) ? raw : Array.isArray((raw as any)?.slots) ? (raw as any).slots : [];
  if (arr.length === 0) return [];

  const isSchemaOnly = (v: any): boolean => {
    if (!v || typeof v !== 'object') return false;
    const keys = Object.keys(v);
    if (keys.length === 0) return false;
    return keys.every((k) => k === 'id' || k === 'key' || k === 'required' || k === 'hint');
  };

  const nonSchema = arr.filter((x) => !isSchemaOnly(x));
  if (nonSchema.length === 0) return [];

  return nonSchema;
}

function renderSlotPlanText(slotPlan: any[]): string {
  const lines: string[] = [];

  const push = (v: unknown) => {
    const t = String(v ?? '').trim();
    if (!t) return;
    lines.push(t);
  };

  for (const s of slotPlan ?? []) {
    if (s == null) continue;

    // ✅ writer seed 用：@OBS/@SHIFT/@SAFE/@NEXT_HINT など “内部行も保持”
    if (typeof s === 'string') {
      push(s);
      continue;
    }

    const obj: any = s;

    const content = typeof obj.content === 'string' ? obj.content.trim() : '';
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    const lns = Array.isArray(obj.lines) ? obj.lines : null;

    if (content) {
      push(content);
      continue;
    }
    if (text) {
      push(text);
      continue;
    }

    if (lns) {
      for (const l of lns) push(l);
      if (lines.length > 0) continue;
    }

    const hint =
      typeof obj.hint === 'string'
        ? obj.hint.trim()
        : typeof obj.prompt === 'string'
          ? obj.prompt.trim()
          : typeof obj.message === 'string'
            ? obj.message.trim()
            : '';

    const looksLikeFramePlanSlotDef =
      typeof obj.id === 'string' &&
      typeof obj.required === 'boolean' &&
      typeof obj.hint === 'string' &&
      !content &&
      !text &&
      !lns;

    // framePlan の “スロット定義” は混ぜない
    if (hint && !looksLikeFramePlanSlotDef) {
      push(hint);
      continue;
    }

    const seedLike =
      typeof obj.seed_text === 'string'
        ? obj.seed_text.trim()
        : typeof obj.seedText === 'string'
          ? obj.seedText.trim()
          : typeof obj.contentText === 'string'
            ? obj.contentText.trim()
            : '';

    if (seedLike) {
      push(seedLike);
      continue;
    }
  }

  return lines.join('\n').trim();
}


/* =========================
 * writerHints injection (MIN, backup only)
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

  const sa = getSaDecision(metaForSave);
  const assertOk = policy === 'FINAL' && sa === 'OK';

  const current = ex.writerHints && typeof ex.writerHints === 'object' ? (ex.writerHints as WriterHints) : null;

  if (!assertOk) return;

  const next: WriterHints = {
    final: true,
    allowAssertive: true,
    avoidHedge: true,
    avoidQuestions: true,
    ...(current ?? {}),
  };

  metaForSave.extra = metaForSave.extra ?? {};
  metaForSave.extra.writerHints = next;

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

// ✅ UI cue (LLM本文に依存しない、UIが読むための確定トリガー)
function ensureUiCue(metaForSave: any): void {
  if (!metaForSave || typeof metaForSave !== 'object') return;

  const ex: any = (metaForSave as any).extra ?? ((metaForSave as any).extra = {});
  const ctx = (ex.ctxPack && typeof ex.ctxPack === 'object') ? ex.ctxPack : null;

  // 1) FLOW
  const flowDelta =
    (metaForSave as any)?.flow?.delta ??
    ctx?.flow?.delta ??
    ex?.flow?.delta ??
    null;

  const returnStreak =
    ctx?.flow?.returnStreak ??
    ex?.flow?.returnStreak ??
    null;

  // 2) STALL
  const stallSeverity =
    ex?.stallHard?.severity ??
    ex?.stall?.severity ??
    null;

  const stallReason =
    ex?.stallHard?.reason ??
    ex?.stall?.reason ??
    null;

  // 3) IT / T-layer
  const itTriggered =
    (metaForSave as any)?.itTriggered ??
    (metaForSave as any)?.it_triggered ??
    (metaForSave as any)?.itTrigger?.ok ??
    (metaForSave as any)?.it_trigger?.ok ??
    null;

  const itxStep =
    (metaForSave as any)?.itxStep ??
    (metaForSave as any)?.itx_step ??
    null;

  const tLayerHint =
    (metaForSave as any)?.tLayerHint ??
    (metaForSave as any)?.t_layer_hint ??
    ctx?.tLayerHint ??
    null;

  // 4) ANCHOR
  const intentAnchorKey =
    (metaForSave as any)?.intentAnchorKey ??
    (metaForSave as any)?.intent_anchor_key ??
    (metaForSave as any)?.intent_anchor?.key ??
    ctx?.intentAnchorKey ??
    null;

  // 5) EXPRESSION（表現レーンが発火したか）
  const exprLane =
    ex?.exprDecision?.lane ??
    ex?.expr?.lane ??
    ctx?.exprMeta?.lane ??
    null;

  const exprFired =
    ex?.exprDecision?.fired ??
    ex?.expr?.fired ??
    null;

  // 6) UI MODE（現状 NORMAL/IR だけでも良い）
  const uiMode =
    (metaForSave as any)?.mode === 'IR' ? 'IR' : 'NORMAL';

  // ✅ ここだけをUIが読む（LLM本文を読まない）
  ex.uiCue = {
    rev: 'uiCue@v1',
    uiMode,
    flowDelta,
    returnStreak,
    stallSeverity,
    stallReason,
    itTriggered,
    itxStep,
    tLayerHint,
    intentAnchorKey,
    exprFired,
    exprLane,
    // 便利な「現在値」も同梱（UI側の変換コスト削減）
    qCode:
      (metaForSave as any)?.qCode ??
      (metaForSave as any)?.q_code ??
      (metaForSave as any)?.qPrimary ??
      null,
    depthStage:
      (metaForSave as any)?.depthStage ??
      (metaForSave as any)?.depth_stage ??
      (metaForSave as any)?.depth ??
      null,
    phase:
      (metaForSave as any)?.phase ??
      null,
    slotPlanPolicy:
      (metaForSave as any)?.framePlan?.slotPlanPolicy ??
      (metaForSave as any)?.slotPlanPolicy ??
      null,
  };
}

/* =========================
 * seed sanitize（writerへ渡す本文化）
 * ========================= */

function sanitizeLlmRewriteSeed(seedRaw: unknown, userText?: string | null): string {
  const s = String(seedRaw ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) return '';

  const userTrim = String(userText ?? '').replace(/\r\n/g, '\n').trim();

  const parts: string[] = [];
  const push = (v: unknown) => {
    const t = String(v ?? '').replace(/\r\n/g, '\n').trim();
    if (!t) return;
    if (userTrim && t === userTrim) return; // userText 同一は混ぜない
    if (parts.length && parts[parts.length - 1] === t) return; // 連続重複除去
    parts.push(t);
  };

  const lines = s.split('\n');

  for (const line0 of lines) {
    const lineTrim = String(line0 ?? '').trim();
    if (!lineTrim) continue;

    if (userTrim && lineTrim === userTrim) continue;

    if (lineTrim.startsWith('@SEED_TEXT')) {
      const json = lineTrim.slice('@SEED_TEXT'.length).trim();
      try {
        const obj = JSON.parse(json);
        push(obj?.text ?? obj?.content ?? '');
      } catch {}
      continue;
    }

    if (lineTrim.startsWith('@Q_SLOT')) {
      const json = lineTrim.slice('@Q_SLOT'.length).trim();
      try {
        const obj = JSON.parse(json);
        push(obj?.seed_text ?? obj?.seedText ?? obj?.content ?? obj?.text ?? '');
      } catch {}
      continue;
    }

    if (lineTrim.startsWith('@OBS')) {
      const json = lineTrim.slice('@OBS'.length).trim();
      try {
        const obj = JSON.parse(json);
        push(obj?.text ?? obj?.content ?? '');
      } catch {}
      continue;
    }

    if (lineTrim.startsWith('@NEXT_HINT')) {
      const json = lineTrim.slice('@NEXT_HINT'.length).trim();
      try {
        const obj: any = JSON.parse(json);
        const v =
          (typeof obj?.content === 'string' && obj.content.trim()) ||
          (typeof obj?.hint === 'string' && obj.hint.trim()) ||
          (typeof obj?.text === 'string' && obj.text.trim()) ||
          (typeof obj?.message === 'string' && obj.message.trim()) ||
          '';
        if (v) push(v);
      } catch {
        // 解析できない場合は落とす（内部マーカー露出防止）
      }
      continue;
    }

    // その他の通常行
    if (lineTrim.startsWith('@')) continue; // 内部マーカーは露出させない
    push(lineTrim);
  }

  return parts.join('\n').trim();
}

/* =========================
 * main
 * ========================= */

export async function postProcessReply(args: PostProcessReplyArgs): Promise<PostProcessReplyOutput> {
  const { orchResult, supabase, userCode, userText, conversationId } = args;

  // 1) 本文抽出
  let finalAssistantText = extractAssistantText(orchResult);

  // 2) metaForSave clone
  const metaRaw =
    orchResult && typeof orchResult === 'object' && (orchResult as any).meta ? (orchResult as any).meta : null;
  const metaForSave: any = metaRaw && typeof metaRaw === 'object' ? { ...metaRaw } : {};

  // extra は必ず存在
  metaForSave.extra = metaForSave.extra ?? {};

  // ✅ 正本一本化：metaForSave.framePlan が無い場合だけ orchResult.framePlan で補完
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
          : metaForSave?.situation_topic ?? metaForSave?.situationTopic ?? metaForSave?.topicLabel ?? null;

      const limit = typeof args.pastStateLimit === 'number' && Number.isFinite(args.pastStateLimit) ? args.pastStateLimit : 3;

      const forceFallback =
        typeof args.forceRecentTopicFallback === 'boolean' ? args.forceRecentTopicFallback : Boolean(topicLabel);

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
  // 6) Q1_SUPPRESS沈黙止血 + 空本文stopgap
  // =========================================================

  const allowLLM = getSpeechAllowLLM(metaForSave);

  let slotPlanLen: number | null = null;
  let hasSlots = false;
  let slotPlanExpected = false;

  // 6-A) Q1_SUPPRESS沈黙止血：本文は必ず空
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

  // 6-B) 非無言アクトの空本文 stopgap（seed→writer優先）
  try {
    const bodyText = String(finalAssistantText ?? '').trim();

    const info = pickSlotPlanLenAndPresence(metaForSave);
    slotPlanLen = info.slotPlanLen;
    hasSlots = info.hasSlots;

    slotPlanExpected = typeof slotPlanLen === 'number' && slotPlanLen > 0;

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

    const isNonSilenceButEmpty =
      !isSpeechSilenceLike && bodyText.length === 0 && String(userText ?? '').trim().length > 0;

    if (isNonSilenceButEmpty && slotPlanExpected) {
      const det = readSlotPlanPolicy(metaForSave);

      const slotPlanArr = pickSlotPlanArrayPreferContent(metaForSave);
      const slotText = renderSlotPlanText(slotPlanArr);

      console.log('[IROS/PostProcess][SLOTPLAN_POLICY]', {
        conversationId,
        userCode,
        slotPlanPolicy_detected: det.policy,
        slotPlanPolicy_from: det.from,
        slotPlanPolicy_raw: det.raw,
        slotPlanLen,
        hasSlots,
      });

      // coreLine は deterministic（憶測禁止）
      const coreLine = String(userText ?? '').replace(/\s+/g, ' ').trim();

      // CANON stamp（pre MIRROR_FLOW）
      try {
        const canonical = canonicalizeIrosMeta({
          metaForSave,
          userText: (args as any)?.userText ?? (args as any)?.inputText ?? null,
        });
        applyCanonicalToMetaForSave(metaForSave, canonical);

        console.log('[IROS/CANON][STAMP][PP]', {
          conversationId,
          userCode,
          q_code: (metaForSave as any)?.q_code ?? null,
          depth_stage: (metaForSave as any)?.depth_stage ?? null,
          phase: (metaForSave as any)?.phase ?? null,
        });
      } catch (e) {
        console.warn('[IROS/CANON][STAMP][PP] failed', e);
      }

// MIRROR_FLOW v1（観測→追記のみ）
try {
  const stage = (metaForSave as any)?.coord?.stage ?? (metaForSave as any)?.extra?.coord?.stage ?? null;
  const band = (metaForSave as any)?.coord?.band ?? (metaForSave as any)?.extra?.coord?.band ?? null;

  // ✅ polarity の入力元を増やす（meta直下の polarityBand を mirrorFlow に橋渡し）
  const polarityBand =
    (metaForSave as any)?.polarityBand ??
    (metaForSave as any)?.extra?.polarityBand ??
    (metaForSave as any)?.extra?.ctxPack?.polarityBand ??
    null;

  const polarityFromMirrorRaw =
    (metaForSave as any)?.mirror?.polarity ??
    (metaForSave as any)?.extra?.mirror?.polarity ??
    null;

  // MirrorFlowInputV1.polarity は PolarityV1('yin'|'yang') を要求するので、
  // 'positive'/'negative' や object 形状もここで正規化して渡す
  const normalizePolarity = (raw: any): PolarityV1 | null => {
    if (raw == null) return null;

    // string: 'yin' | 'yang' | 'positive' | 'negative'
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (!s) return null;
      if (s === 'yin' || s === 'yang') return s;
      if (s === 'positive') return 'yang';
      if (s === 'negative') return 'yin';
      return null;
    }

    // object: { in, out } or { polarityBand } など
    if (typeof raw === 'object') {
      const vIn = normalizePolarity((raw as any).in);
      if (vIn) return vIn;

      const vOut = normalizePolarity((raw as any).out);
      if (vOut) return vOut;

      const vBand = normalizePolarity((raw as any).polarityBand);
      if (vBand) return vBand;
    }

    return null;
  };

  const polarityFromMirror = normalizePolarity(polarityFromMirrorRaw);
  const polarityFromBand = normalizePolarity(polarityBand);

  // ✅ canonical yin/yang（キー用）
  const polarityCanon: PolarityV1 | null = polarityFromMirror ?? polarityFromBand ?? null;

// ✅ metaBand（表示・診断用）：raw帯域を保持（positive/negative）
const polarityMetaBand: string | null =
  (typeof (polarityFromMirrorRaw as any)?.metaBand === 'string' &&
  (polarityFromMirrorRaw as any).metaBand.trim()
    ? (polarityFromMirrorRaw as any).metaBand.trim()
    : null) ??
  (typeof (polarityFromMirrorRaw as any)?.polarityBand === 'string' &&
  (polarityFromMirrorRaw as any).polarityBand.trim()
    ? (polarityFromMirrorRaw as any).polarityBand.trim()
    : null) ??
  (typeof polarityBand === 'string' && polarityBand.trim() ? polarityBand.trim() : null);
  // ✅ MirrorFlow へは object で渡す（stringにすると metaBand が 'yang' になってしまう）
  const polarity: any =
    polarityCanon == null
      ? null
      : {
          in: polarityCanon,
          out: polarityCanon,
          metaBand: polarityMetaBand,
        };

  console.info('[IROS/PP][POLARITY_BRIDGE]', {
    polarityBand_raw: polarityBand ?? null,
    polarityFromMirror_raw: polarityFromMirrorRaw ?? null,
    polarity_normalized: polarityCanon,
    polarity_metaBand_raw: polarityMetaBand,
  });
  const flowDelta_mf =
    (metaForSave as any)?.flow?.delta ??
    (metaForSave as any)?.extra?.ctxPack?.flow?.delta ??
    (metaForSave as any)?.extra?.flow?.delta ??
    null;

  const returnStreak_mf =
    (metaForSave as any)?.extra?.ctxPack?.flow?.returnStreak ??
    (metaForSave as any)?.extra?.flow?.returnStreak ??
    null;

  const sessionBreak_mf = (metaForSave as any)?.extra?.ctxPack?.flow?.sessionBreak ?? null;
  const mf = buildMirrorFlowV1({
    userText: String(userText ?? ''),
    stage,
    band,
    polarity,
    flow: {
      delta: (flowDelta_mf ?? null) as any,
      returnStreak: (returnStreak_mf ?? null) as any,
      sessionBreak: (sessionBreak_mf ?? null) as any,
    },
  });

  metaForSave.extra = {
    ...(metaForSave.extra ?? {}),
    mirrorFlowV1: mf,
    mirror: (metaForSave as any)?.extra?.mirror ?? mf.mirror,
    flowMirror: (metaForSave as any)?.extra?.flowMirror ?? mf.flow,
  };

  if ((metaForSave as any).mirror == null) {
    (metaForSave as any).mirror = mf.mirror;
  }

  console.log('[IROS/MIRROR_FLOW][RESULT]', {
    micro: mf.flow.micro,
    confidence: mf.mirror.confidence,
    e_turn: mf.mirror.e_turn ?? null,
    polarity_in: (mf.mirror as any)?.polarity?.in ?? null,
    polarity_metaBand: (mf.mirror as any)?.polarity?.metaBand ?? null,
    polarity_out: (mf.mirror as any)?.polarity?.out ?? null,
    meaningKey: mf.mirror.meaningKey,
    colorKey: mf.mirror.field?.colorKey ?? null,
    flowDelta: mf.flow.delta,
    returnStreak: mf.flow.returnStreak,
  });
} catch (e) {
  console.warn('[IROS/MIRROR_FLOW][ERR]', { err: String(e) });
}

      // Expression Lane（preface 1行）
      const exprDecision = (() => {
        try {
          const laneKey =
            String((metaForSave as any)?.extra?.intentBridge?.laneKey ?? (metaForSave as any)?.laneKey ?? '').trim() ||
            'IDEA_BAND';

          const phase = ((metaForSave as any)?.phase ?? (metaForSave as any)?.framePlan?.phase ?? null) as any;
          const depth = ((metaForSave as any)?.depth ?? (metaForSave as any)?.depthStage ?? null) as any;
          const allow = ((metaForSave as any)?.allow ?? (metaForSave as any)?.extra?.allow ?? null) as any;

          const flowDelta =
          (metaForSave as any)?.flow?.delta ??
          (metaForSave as any)?.extra?.ctxPack?.flow?.delta ??
          (metaForSave as any)?.extra?.flow?.delta ??
          null;

        const returnStreak =
          (metaForSave as any)?.extra?.ctxPack?.flow?.returnStreak ??
          (metaForSave as any)?.extra?.flow?.returnStreak ??
          null;

        const sessionBreak = (metaForSave as any)?.extra?.ctxPack?.flow?.sessionBreak ?? null;

          const flags = (() => {
            const ex: any = (metaForSave as any)?.extra ?? {};
            const sev =
              ex?.stall?.severity ??
              ex?.stallProbe?.severity ??
              ex?.tConcretize?.stall?.severity ??
              ex?.t_concretize?.stall?.severity ??
              ex?.forceSwitch?.stall?.severity ??
              ex?.ctxPack?.stall?.severity ??
              null;

            return {
              enabled: ex?.exprEnabled ?? true,
              stallHard: Boolean(ex?.stallHard ?? (sev === 'hard')),
            };
          })();

          const exprAllow = (metaForSave as any)?.extra?.exprAllow ?? (metaForSave as any)?.exprAllow ?? null;
          const signals =
          (metaForSave as any)?.extra?.signals ??
          (metaForSave as any)?.signals ??
          null;


        const d = decideExpressionLane({
          laneKey,
          phase,
          depth,
          allow,
          exprAllow,
          flow: { flowDelta: flowDelta ?? null, returnStreak: returnStreak ?? null },
          signals,
          flags,
          traceId: (metaForSave as any)?.traceId ?? null,
        } as any);


// metaPatch は 1回だけ merge
if (d?.metaPatch && typeof d.metaPatch === 'object') {
  metaForSave.extra = { ...(metaForSave.extra ?? {}), ...d.metaPatch };
}
// ✅ exprDecision は従来どおり保存しつつ、
// ✅ ctxPack.exprMeta（正本）に fired/lane/reason を合流して systemPrompt へ届ける
{
  // ✅ 既存extraを安全に回収
  const prevExtra: any =
    (metaForSave as any)?.extra && typeof (metaForSave as any).extra === 'object'
      ? (metaForSave as any).extra
      : (((metaForSave as any).extra = {}) as any);

  const prevCtxPack: any =
    prevExtra?.ctxPack && typeof prevExtra.ctxPack === 'object' ? prevExtra.ctxPack : {};

  // 既存の exprMeta がどこかに入ってたら拾う（ctxPack優先 → extra）
  const prevExprMeta: any =
    (prevCtxPack?.exprMeta && typeof prevCtxPack.exprMeta === 'object' ? prevCtxPack.exprMeta : null) ??
    (prevExtra?.exprMeta && typeof prevExtra.exprMeta === 'object' ? prevExtra.exprMeta : null) ??
    {};

  const fired = Boolean((d as any)?.fired);
  const lane = String((d as any)?.lane ?? 'OFF');
  const reason = String((d as any)?.reason ?? 'DEFAULT');

  const prefaceLine = String((d as any)?.prefaceLine ?? '').trim() || null;

  // --- ✅ ExprDirectiveV1（e_turn → 構成/リメイク/I層返し優先）を条件付きで生成 ---
  const mirrorObj: any = (metaForSave as any)?.mirror ?? (metaForSave as any)?.extra?.mirror ?? null;

  const e_turn: any = (mirrorObj as any)?.e_turn ?? null;
  const confidence: number = Number((mirrorObj as any)?.confidence ?? 0) || 0;
  const polarity: any = (mirrorObj as any)?.polarity_out ?? (mirrorObj as any)?.polarity ?? null;

  const flowDeltaNorm = String(flowDelta ?? '').toUpperCase();
  const returnStreakNum = Math.max(0, Number(returnStreak ?? 0) || 0);

  // OFF: micro / directTask
  // micro はこの地点で確実に参照できる mf.flow.micro を使う
  const microNow = Boolean((metaForSave as any)?.extra?.mirrorFlowV1?.flow?.micro);

  // 要件（microを壊さない/常時発火させない）を守りつつ「現状挙動を変えない」= 常に false で固定する。
  // ※後で directTask を配線したくなったら、postProcessReply(args) の引数から明示的に渡すのが正道。
  const directTaskNow = false;

  // ON条件：RETURN && streak>=1 OR lane=sofia_light
  const onByFlow = flowDeltaNorm === 'RETURN' && returnStreakNum >= 1;
  const onByLane = lane === 'sofia_light';
  const onBase = onByFlow || onByLane;

  // confidence閾値（hard局面は緩和）
  const hardNow =
    Boolean((d as any)?.debug?.stallHard ?? false) ||
    String((d as any)?.debug?.techniqueId ?? '') === 'stall_hard';

  // sofia_light は “表現の整形だけ” なので、mirror信頼度を緩める
  const th = (hardNow || lane === 'sofia_light') ? 0.15 : 0.55;
  const onByConf = confidence >= th;

  // e_turn が無いなら directive は出さない（安全）
  const directiveV1_on = !!(onBase && onByConf && !directTaskNow && e_turn);

  const directiveV1_reason = directiveV1_on
    ? (microNow ? 'ON_MICRO_ALLOWED' : 'ON')
    : (directTaskNow ? 'OFF_DIRECT_TASK' : (onBase ? 'OFF_LOW_CONF' : 'OFF_NOT_TARGET'));

  // ✅ 本文は変えず「言い方だけ」を Writer に伝える（短い内部指示）
  let directiveV1 = directiveV1_on
    ? (buildExprDirectiveV1({
        e_turn: (e_turn ?? null) as any,
        flowDelta: (flowDelta ?? null) as any,
        returnStreak: returnStreakNum,
        confidence,
        // polarity はここでは未配線でもOK（型は optional）
      }) || '')
    : '';

// ====== directiveV1 追記（let directiveV1 = ... の直後に置く） ======
{
  const mirrorObj: any = (metaForSave as any)?.mirror ?? (metaForSave as any)?.extra?.mirror ?? null;

  const et = String(mirrorObj?.e_turn ?? '').trim(); // e1..e5
  const pol = String(mirrorObj?.polarity_out ?? mirrorObj?.polarity ?? '').trim(); // yin/yang など

  const userTextNow =
    String((metaForSave as any)?.userText ?? '').trim() ||
    String((metaForSave as any)?.text ?? '').trim() ||
    '';

  if (typeof directiveV1 === 'string' && directiveV1.trim()) {
    const extraLines: string[] = [
      'prefaceLine：本文の先頭に「いまは〜段階です。」の1文を必ず置く（1行・1文・改行なし）。',
      'prefaceLine：この1文は毎ターン生成する。固定テンプレの使い回しは禁止。',
      et
        ? `prefaceLine：材料はユーザー発話と e_turn（${et}）${pol ? ` と polarity（${pol}）` : ''}。ただし e_turn/polarity のラベルは本文に出さない。`
        : 'prefaceLine：材料はユーザー発話。内部ラベルは本文に出さない。',
      'prefaceLine：状況説明や共感の羅列は禁止。焦点（何が削られているか／何が残っているか）だけを一点に絞る。',
    ];

    if (userTextNow) {
      extraLines.push(`prefaceLine：ユーザー発話="${userTextNow.slice(0, 80)}" を参照して具体化する。`);
    }

    const base = directiveV1.split('\n').filter(Boolean);
    directiveV1 = [...extraLines, ...base].slice(0, 8).join('\n').trim();
  }
}
// ====== 追記ここまで ======

  // micro（短文）でも 1行だけ許可したい時は、8行制限を超えない範囲で追記
  if (directiveV1 && microNow) {
    const ls = directiveV1.split('\n').filter(Boolean);
    if (ls.length < 8) ls.push('micro：短文でも、1行の前置き/整形は許可。');
    directiveV1 = ls.slice(0, 8).join('\n').trim();
  }

  console.log('[IROS/EXPR][DIRECTIVE_V1]', {
    conversationId,
    userCode,
    on: directiveV1_on,
    reason: directiveV1_reason,
    e_turn: e_turn ?? null,
    confidence,
    flowDelta: (flowDelta ?? null),
    returnStreak: returnStreakNum,
    head: String(directiveV1 ?? '').slice(0, 96),
  });

  // ✅ meta.extra を一度で確定（IIFEは禁止）
  metaForSave.extra = {
    ...prevExtra,

    // ✅ renderGateway が拾う “prefaceLine” の正本
    expr: {
      ...(prevExtra?.expr ?? {}),
      prefaceLine,
      prefaceHead: prefaceLine ? prefaceLine.slice(0, 64) : null,
    },

    // meta.extra.exprMeta（renderGateway/systemPrompt が見る）
    exprMeta: {
      ...prevExprMeta,
      fired,
      lane,
      reason,

      // ✅ NEW: directiveV1
      directiveV1,
      directiveV1_on,
      directiveV1_reason,
    },

    // ✅ 正本：handleIrosReply.ts がここから同期する
    ctxPack: {
      ...prevCtxPack,
      exprMeta: {
        ...prevExprMeta,
        fired,
        lane,
        reason,

        // ✅ NEW: directiveV1（正本に同値反映）
        directiveV1,
        directiveV1_on,
        directiveV1_reason,
      },
    },

    // 従来の保存（ログ/診断用）
    exprDecision: {
      fired,
      lane,
      reason,
      blockedBy: ((d as any)?.blockedBy ?? null) as any,
      hasPreface: !!String((d as any)?.prefaceLine ?? '').trim(),
    },
  };
}

          console.log('[IROS/EXPR][decision]', {
            conversationId,
            userCode,
            fired: !!d?.fired,
            lane: String(d?.lane ?? 'OFF'),
            reason: String(d?.reason ?? 'DEFAULT'),
            blockedBy: d?.blockedBy ?? null,
            prefaceHead: String(d?.prefaceLine ?? '').slice(0, 64),
            debug: (d as any)?.debug ?? null,
          });

          return d;
        } catch (e) {
          const d = {
            fired: false,
            lane: 'OFF',
            reason: 'DEFAULT',
            blockedBy: 'DISABLED',
            prefaceLine: null,
            shouldPolish: false,
            metaPatch: { expr: { fired: false, blockedBy: 'DISABLED', at: Date.now(), error: String(e ?? '') } },
          } as any;

          if (d?.metaPatch && typeof d.metaPatch === 'object') {
            metaForSave.extra = { ...(metaForSave.extra ?? {}), ...d.metaPatch };
          }

          metaForSave.extra = {
            ...(metaForSave.extra ?? {}),
            exprDecision: { fired: false, lane: 'OFF', reason: 'DEFAULT', blockedBy: 'DISABLED', hasPreface: false },
          };

          console.log('[IROS/EXPR][decision]', {
            conversationId,
            userCode,
            fired: false,
            lane: 'OFF',
            reason: 'DEFAULT',
            blockedBy: 'DISABLED',
            prefaceHead: '',
            error: String(e ?? ''),
          });

          return d;
        }
      })();

      // seed を作る（preface 1回だけ）
      const slotTextStr = String(slotText ?? '').trim();
      const preface = String((exprDecision as any)?.prefaceLine ?? '').trim();
      const mfNow =
      (metaForSave as any)?.extra?.mirrorFlow ?? (metaForSave as any)?.mirrorFlow ?? (metaForSave as any)?.mirror_flow ?? null;
    const microNow = Boolean(mfNow?.flow?.micro);
      const shouldInjectPreface =
        (exprDecision as any)?.fired === true &&
        preface.length > 0 &&
        !slotTextStr.startsWith(preface) &&
        !microNow;

      let seedForWriterRaw = shouldInjectPreface ? `${preface}\n${slotTextStr}` : slotTextStr;

      // ===== C案: NEXT_HINT を writer seed に「自然文1行」で混ぜる（vector不要）=====
      const nextHintLine = (() => {
        const lines = String(slotTextStr ?? '').split('\n');
        for (const line of lines) {
          const s = String(line ?? '').trim();
          if (!s.startsWith('@NEXT_HINT')) continue;
          const raw = s.slice('@NEXT_HINT'.length).trim();
          try {
            const obj = JSON.parse(raw);
            const hint = typeof obj?.hint === 'string' ? obj.hint.trim() : '';
            return hint || null;
          } catch {
            return null;
          }
        }
        return null;
      })();

      // 既存の seedForWriterRaw（この行は元からあるはず）を再宣言しない
      //
      // ✅ FIX: NEXT_HINT を「自然文1行」で seed に混ぜない
      // - ここで混ぜると seedForWriterSanitized が hint 単体に収束し、
      //   allowLLM=true でも finalAssistantText（baseVisible）が hint 固定になる事故が起きる。
      // - NEXT_HINT は slotPlan 内の "@NEXT_HINT {...}" として保持し、
      //   UI補完（renderGateway側）や evidence 用にのみ使う。
      //
      // if (nextHintLine && typeof seedForWriterRaw === 'string' && !seedForWriterRaw.includes(nextHintLine)) {
      //   seedForWriterRaw = `${seedForWriterRaw}\n${nextHintLine}`.trim();
      // }


      // 露出OKの核1行を混ぜる（短すぎる時だけ）
      const CLEAN_MIN = 48;
      const cleaned0 = seedForWriterRaw
        .split('\n')
        .map((l) => String(l ?? '').trim())
        .filter((l) => l.length > 0 && !l.startsWith('@'))
        .join('\n')
        .trim();

      if (coreLine && cleaned0.length < CLEAN_MIN && !seedForWriterRaw.includes(coreLine)) {
        const seedLine = `@SEED_TEXT ${JSON.stringify({ text: coreLine })}`;
        seedForWriterRaw = `${seedForWriterRaw}\n${coreLine}\n${seedLine}`.trim();
      }

      // sanitize
      const seedForWriterSanitized = sanitizeLlmRewriteSeed(seedForWriterRaw, userText);

      // meta肥大対策：rawはdev限定 + 長さ制限
      const isDev = process.env.NODE_ENV !== 'production';
      const RAW_LIMIT = 8192;
      const rawSafe = isDev ? String(seedForWriterRaw ?? '').slice(0, RAW_LIMIT) : null;

      metaForSave.extra = {
        ...(metaForSave.extra ?? {}),
        slotPlanPolicy_detected: det.policy,
        slotPlanPolicy_from: det.from,
        slotPlanLen_detected: slotPlanLen,
        hasSlots_detected: hasSlots,

        llmRewriteSeed: seedForWriterSanitized,
        llmRewriteSeedRaw: rawSafe,
        llmRewriteSeedRawTruncated: isDev ? String(seedForWriterRaw ?? '').length > RAW_LIMIT : undefined,
        llmRewriteSeedRawLen: isDev ? String(seedForWriterRaw ?? '').length : undefined,

        llmRewriteSeedFrom: 'postprocess(slotPlan->writer-seed)',
        llmRewriteSeedAt: new Date().toISOString(),
      };

      // allowLLM=false のときだけ deterministic commit
      if (allowLLM === false) {
        const commitText =
          String(seedForWriterSanitized ?? '').trim() || String(coreLine ?? '').trim() || '（受信しました）';

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
        // writer に委ねる（baseVisible は seedSanitized 優先）
        let baseVisible =
          String(seedForWriterSanitized ?? '').trim() || String(coreLine ?? '').trim() || '';

        if (det?.policy === 'FINAL' && baseVisible.trim().startsWith('hint ')) {
          baseVisible = '';
        }

        finalAssistantText = baseVisible;

        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          finalTextPolicy: 'FINAL__LLM_COMMIT',
          slotPlanCommitted: false,
          baseVisibleLen: baseVisible.length,
          baseVisibleHead: baseVisible.slice(0, 64),
          baseVisibleSource: String(seedForWriterSanitized ?? '').trim() ? 'seedForWriterSanitized' : 'coreLine(lastResort)',
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
          seedLen: String(seedForWriterSanitized ?? '').length,
          seedHead: String(seedForWriterSanitized ?? '').slice(0, 48),
        });
      }
    } else if (isNonSilenceButEmpty && !slotPlanExpected) {
      // ACK_FALLBACK（seed無しのときのみ）
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
        const callName =
          metaForSave?.userProfile?.user_call_name ?? (metaForSave.extra as any)?.userProfile?.user_call_name ?? 'orion';

        const u = String(userText ?? '').replace(/\s+/g, ' ').trim();
        const ul = u.toLowerCase();

        const looksLikeGreeting =
          ul === 'こんにちは' || ul === 'こんばんは' || ul === 'おはよう' || ul.includes('はじめまして') || ul.includes('よろしく');

        finalAssistantText = looksLikeGreeting ? `こんにちは、${callName}さん。🪔` : 'うん、届きました。🪔';

        metaForSave.extra = { ...(metaForSave.extra ?? {}), finalTextPolicy: 'ACK_FALLBACK', emptyFinalPatched: true };
      }
    }
  } catch (e) {
    console.warn('[IROS/PostProcess] non-silence empty patch failed', e);
  }

  // =========================================================
  // writerHints の欠損補完
  // =========================================================
  try {
    ensureWriterHints(metaForSave, { conversationId, userCode });
  } catch (e) {
    console.warn('[IROS/PostProcess] ensureWriterHints failed (non-fatal)', e);
  }
    // ✅ UIが読む確定cue（LLM本文から分離）
    ensureUiCue(metaForSave);
  // =========================================================
  // extractedTextFromModel / rawTextFromModel 同期（最後に1回だけ）
  // =========================================================
  if (metaForSave && typeof metaForSave === 'object') {
    metaForSave.extra = (metaForSave as any).extra ?? {};
    const ex: any = (metaForSave as any).extra;

    const finalText = String(finalAssistantText ?? '').trim();
    const prevRaw = String(ex?.rawTextFromModel ?? '').trim();

    ex.extractedTextFromModel = finalText;

    if (!prevRaw && finalText) {
      ex.rawTextFromModel = finalText;
    }
  }

  // =========================================================
  // 7) UnifiedAnalysis 保存（失敗しても落とさない）
  // =========================================================
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
      userCode,
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
