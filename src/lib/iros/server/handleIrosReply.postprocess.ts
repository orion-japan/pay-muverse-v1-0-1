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
import { normalizeIrosStyleFinal } from '../language/normalizeIrosStyleFinal';

import {
  buildUnifiedAnalysis,
  saveUnifiedAnalysisInline,
  applyAnalysisToLastUserMessage,
} from './handleIrosReply.analysis';

import {
  canonicalizeIrosMeta,
  applyCanonicalToMetaForSave,
} from '@/lib/iros/server/handleIrosReply.meta';
import {
  computeViewShiftV1,
  buildViewShiftSnapshot,
} from '../viewShift/viewShift.v1';

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
function buildResonanceSeedText(state: any): string {
  const parts: string[] = [];

  const et = typeof state?.instant?.e_turn === 'string' ? state.instant.e_turn.trim() : '';
  const flowDelta =
    typeof state?.instant?.flow?.delta === 'string'
      ? state.instant.flow.delta.trim()
      : '';

  const returnStreak =
    typeof state?.instant?.flow?.returnStreak === 'number'
      ? state.instant.flow.returnStreak
      : 0;

  if (et) {
    parts.push(`反応:${et}`);
  }

  if (flowDelta || returnStreak) {
    parts.push(`流れ:${flowDelta || '—'} / 戻り:${returnStreak}`);
  }

  return parts.join('\n').trim();
}
function buildResonanceState(args: { metaForSave: any; userText: string }): any {
  const { metaForSave } = args;

  const ex: any = (metaForSave as any)?.extra ?? {};
  const ctx: any = ex?.ctxPack && typeof ex.ctxPack === 'object' ? ex.ctxPack : {};

  const mirrorObj: any =
    (metaForSave as any)?.mirror ??
    ex?.mirror ??
    ex?.mirrorFlowV1?.mirror ??
    ctx?.mirror ??
    null;

  // ✅ flow は「ctxPack.flow（正本）→ extra.flow（互換）→ meta.flow」の順で拾う
  const flowResolved: any =
    (ctx?.flow && typeof ctx.flow === 'object'
      ? ctx.flow
      : ex?.flow && typeof ex.flow === 'object'
        ? ex.flow
        : (metaForSave as any)?.flow && typeof (metaForSave as any).flow === 'object'
          ? (metaForSave as any).flow
          : null) ?? null;

  const vs: any = ctx?.viewShift ?? ex?.viewShift ?? null;

  const saDecision = getSaDecision(metaForSave) ?? null;
  const yuragi = ex?.yuragi ?? ctx?.yuragi ?? ex?.exprMeta?.yuragi ?? ctx?.exprMeta?.yuragi ?? null;
  const yohaku = ex?.yohaku ?? ctx?.yohaku ?? ex?.exprMeta?.yohaku ?? ctx?.exprMeta?.yohaku ?? null;

  const cards = ex?.cards ?? ctx?.cards ?? null;
  const fixedNorth = ex?.fixedNorth ?? ctx?.fixedNorth ?? null;

  const state: any = {
    v: 1,
    instant: {
      e_turn: mirrorObj?.e_turn ?? null,
      confidence: mirrorObj?.confidence ?? null,
      polarity: mirrorObj?.polarity ?? mirrorObj?.polarity_out ?? null,
      flow: {
        delta: flowResolved?.delta ?? null,
        returnStreak: flowResolved?.returnStreak ?? null,
        micro: flowResolved?.micro ?? null,
        sessionBreak: flowResolved?.sessionBreak ?? null,
      },
      viewShift: vs ?? null,
    },
    reading: { saDecision, yuragi, yohaku },
    cards: cards ?? null,
    structure: {
      qCode: (metaForSave as any)?.qCode ?? (metaForSave as any)?.q ?? null,
      depth: (metaForSave as any)?.depth ?? (metaForSave as any)?.depthStage ?? null,
      phase: (metaForSave as any)?.phase ?? null,
      intentBand: ex?.intentBridge?.intentBand ?? (metaForSave as any)?.intentBand ?? null,
      tLayerHint: (metaForSave as any)?.tLayerHint ?? ctx?.tLayerHint ?? null,
      fixedNorth: fixedNorth ?? null,
    },
    seed: {
      seed_text: null,
      at: new Date().toISOString(),
    },
  };

  state.seed.seed_text = buildResonanceSeedText(state);
  return state;
}
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
  // - orchestrator は ex.stallHard に boolean を入れる
  // - 詳細は ex.stall（object）に入るので、まずはそちらを優先する
  const stallHardBool =
    Boolean(ex?.stallHard) || Boolean(ex?.stall?.hardNow) || false;

  const stallSeverity =
    ex?.stall?.severity ??
    (stallHardBool ? 'hard' : null);

  const stallReason =
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
  // 5.9) MIRROR_FLOW / viewShift / cards を常時ルートで生成（stopgap外）
  // - stopgap（6-B）の if に入らない通常ターンでも ctxPack.cards を持たせる
  // - 二重生成を避けるため、既にある場合は上書きしない
  // =========================================================
  try {
    // extra / ctxPack を必ず用意
    (metaForSave as any).extra =
      (metaForSave as any).extra && typeof (metaForSave as any).extra === 'object'
        ? (metaForSave as any).extra
        : {};
    (metaForSave as any).extra.ctxPack =
      (metaForSave as any).extra.ctxPack && typeof (metaForSave as any).extra.ctxPack === 'object'
        ? (metaForSave as any).extra.ctxPack
        : {};

    // 既に mirrorFlowV1 があるなら再生成しない（stopgap側で作られた場合に備える）
    const hasMirrorFlowAlready = !!(metaForSave as any)?.extra?.mirrorFlowV1;

    if (!hasMirrorFlowAlready) {
      // ✅ MirrorFlowV1 は後段（POLARITY_BRIDGE後）の1回生成に統一する。
      // - ここ（前段）で作ると二重生成になり、RESULTログも2回出る。
      // - polarityMetaBand などの補正も後段が正本。
      // - 互換のため、もし既に mirrorFlowV1 がどこかで入っている場合はそれを尊重する。
    }

    // viewShift / snapshot（既にあれば上書きしない）
    const hasViewShift = !!(metaForSave as any)?.extra?.ctxPack?.viewShift;
    const hasViewShiftSnap = !!(metaForSave as any)?.extra?.ctxPack?.viewShiftSnapshot;

      const polarityBand =
        (metaForSave as any)?.polarityBand ??
        (metaForSave as any)?.extra?.polarityBand ??
        (metaForSave as any)?.extra?.ctxPack?.polarityBand ??
        null;

      const polarityFromMirrorRaw =
        (metaForSave as any)?.mirror?.polarity ??
        (metaForSave as any)?.extra?.mirror?.polarity ??
        null;

      const normalizePolarity = (raw: any): PolarityV1 | null => {
        if (raw == null) return null;

        if (typeof raw === 'string') {
          const s = raw.trim();
          if (!s) return null;
          if (s === 'yin' || s === 'yang') return s;
          if (s === 'positive') return 'yang';
          if (s === 'negative') return 'yin';
          return null;
        }

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
      const polarityCanon: PolarityV1 | null = polarityFromMirror ?? polarityFromBand ?? null;

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

      const polarity: any =
        polarityCanon == null
          ? null
          : {
              in: polarityCanon,
              out: polarityCanon,
              metaBand: polarityMetaBand,
            };

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

// ✅ MirrorFlowV1 は後段（POLARITY_BRIDGE後）の1回生成に統一する。
// - ここ（前段）で作ると二重生成になり、RESULTログも2回出る。
// - polarityMetaBand などの補正も後段が正本。
// - 互換のため、もし既に mirrorFlowV1 がどこかで入っている場合はそれを尊重する。


    if (!hasViewShift || !hasViewShiftSnap) {
      const prevSnap: any =
        (metaForSave as any)?.extra?.viewShiftPrev ??
        (metaForSave as any)?.viewShiftPrev ??
        null;

      const depthNow: string | null = (() => {
        const d =
          (metaForSave as any)?.depth ??
          (metaForSave as any)?.depthStage ??
          (metaForSave as any)?.framePlan?.depth ??
          (metaForSave as any)?.framePlan?.depthStage ??
          null;
        const s = typeof d === 'string' ? d.trim() : '';
        return s ? s : null;
      })();

      const mirrorObj: any =
        (metaForSave as any)?.mirror ??
        (metaForSave as any)?.extra?.mirror ??
        (metaForSave as any)?.extra?.mirrorFlowV1?.mirror ??
        null;

      const e_turn: any = mirrorObj?.e_turn ?? null;

      const sessionBreakNow: any =
        (metaForSave as any)?.extra?.ctxPack?.flow?.sessionBreak ??
        (metaForSave as any)?.extra?.flow?.sessionBreak ??
        null;

      if (!hasViewShift) {
        const vs = computeViewShiftV1({
          userText: String(userText ?? ''),
          depth: depthNow,
          e_turn: e_turn ?? null,
          sessionBreak: sessionBreakNow ?? null,
          prev: prevSnap && typeof prevSnap === 'object' ? prevSnap : null,
        } as any);

        (metaForSave as any).extra.ctxPack.viewShift = vs;

        console.log('[IROS/VIEW_SHIFT][ALWAYS]', {
          ok: (vs as any)?.ok ?? null,
          score: (vs as any)?.score ?? null,
          variant: (vs as any)?.variant ?? null,
          confirmLine: (vs as any)?.confirmLine ?? null,
          sessionBreak: sessionBreakNow ?? null,
        });
      }

      if (!hasViewShiftSnap) {
        const snap = buildViewShiftSnapshot({
          userText: String(userText ?? ''),
          depth: depthNow,
          e_turn: e_turn ?? null,
        } as any);

        (metaForSave as any).extra.ctxPack.viewShiftSnapshot = snap;
      }
    }

// =========================================================
// 5.x) cards-lite 生成（ctxPack.cards） + card180 seed 生成（ログ可視化）
// =========================================================
try {
  // cards（既にあれば上書きしない）
  const hasCards = !!(metaForSave as any)?.extra?.ctxPack?.cards;

  if (!hasCards) {
    const qCountsAny: any =
      (metaForSave as any)?.qCounts ??
      (metaForSave as any)?.extra?.qCounts ??
      (metaForSave as any)?.extra?.ctxPack?.qCounts ??
      (metaForSave as any)?.extra?.ctxPack?.q_counts ??
      null;

    const mirrorObjAny: any =
      (metaForSave as any)?.mirror ??
      (metaForSave as any)?.extra?.mirror ??
      (metaForSave as any)?.extra?.mirrorFlowV1?.mirror ??
      null;

    const rawETurn: any =
      qCountsAny?.e_turn_now ??
      qCountsAny?.eTurnNow ??
      mirrorObjAny?.e_turn ??
      null;

    const normalizeETurnKey = (v: any): string | null => {
      if (v == null) return null;

      if (typeof v === 'string') {
        const s = v.trim();
        return s ? s : null;
      }

      if (typeof v === 'object') {
        const c =
          (typeof v.key === 'string' && v.key.trim()) ||
          (typeof v.code === 'string' && v.code.trim()) ||
          (typeof v.e_turn === 'string' && v.e_turn.trim()) ||
          null;

        return c ? String(c).trim() : null;
      }

      return null;
    };

    const eKey = normalizeETurnKey(rawETurn);

    const depthNow =
      (metaForSave as any)?.depth ??
      (metaForSave as any)?.depthStage ??
      (metaForSave as any)?.framePlan?.depth ??
      (metaForSave as any)?.framePlan?.depthStage ??
      null;

    const phaseNow =
      (metaForSave as any)?.phase ??
      (metaForSave as any)?.framePlan?.phase ??
      null;

    const stageNow =
      (metaForSave as any)?.coord?.stage ??
      (metaForSave as any)?.extra?.coord?.stage ??
      null;

    const bandNow =
      (metaForSave as any)?.coord?.band ??
      (metaForSave as any)?.extra?.coord?.band ??
      null;

    // polarity は card180 seed に必要（yin/yang）
    const polRaw: any = mirrorObjAny?.polarity ?? null;
    const polKey: 'yin' | 'yang' | null =
      polRaw === 'yin' || polRaw === 'yang' ? polRaw : null;

    // 既存lite互換（UI互換のため温存）
    const makeLabels = (k: string) => {
      const currentMap: Record<string, string> = {
        e1: 'いま整え直す',
        e2: 'いま伸ばし切る',
        e3: 'いま支え直す',
        e4: 'いま解き放つ',
        e5: 'いま灯し直す',
      };

      const futureMap: Record<string, string> = {
        e1: '次は安定が来る',
        e2: '次は成長が来る',
        e3: '次は定着が来る',
        e4: '次は浄化が来る',
        e5: '次は熱が戻る',
      };

      return {
        current: currentMap[k] ?? 'いま整え直す',
        future: futureMap[k] ?? '次は安定が来る',
      };
    };

    const makeScore = (k: string) => {
      if (k === 'e5') return 90;
      if (k === 'e4') return 78;
      if (k === 'e3') return 66;
      if (k === 'e2') return 54;
      if (k === 'e1') return 42;
      return 50;
    };

    if (eKey) {
      const labels = makeLabels(eKey);
      const stingScore = makeScore(eKey);

      (metaForSave as any).extra = (metaForSave as any).extra ?? {};
      (metaForSave as any).extra.ctxPack = (metaForSave as any).extra.ctxPack ?? {};

      // --- まず lite は従来通り入れる（互換維持）
      (metaForSave as any).extra.ctxPack.cards = {
        current: {
          label: labels.current,
          e_turn: eKey,
          depth: depthNow,
          phase: phaseNow,
        },
        future: {
          label: labels.future,
          e_turn: eKey,
          depth: depthNow,
          phase: phaseNow,
        },
        stingScore,
        hint: {
          stage: stageNow,
          band: bandNow,
        },
      };

      // --- 追加: card180 由来 seedText を生成して保存（ログで見える化）
      // ※ depthNow / polKey が揃っている時だけ（憶測で補完しない）
      if (depthNow && polKey) {
        try {
          const { buildDualCardPacket, formatDualCardPacketForLLM } =
            await import('@/lib/iros/cards/card180');

          const packet = buildDualCardPacket(
            {
              current: {
                stage: depthNow ?? null,
                e_turn: eKey as any,
                polarity: polKey as any,
                sa: (metaForSave as any)?.sa ?? null,
                basedOn: String(userText ?? '').trim().slice(0, 80) || null,
                confidence: (mirrorObjAny?.confidence ?? (metaForSave as any)?.confidence ?? null) as any,
              },
              previous: null,
              randomSeed: null,
            },
            { currentUndetectablePolicy: 'null' }
          );

          const raw = String(formatDualCardPacketForLLM(packet) ?? '').trim();

          // 長すぎると seed に毒なので、まずは安全に「先頭15行」だけ保存
          const seedText = raw ? raw.split('\n').slice(0, 15).join('\n').trim() : '';

          if (seedText) {
            (metaForSave as any).extra.ctxPack.cards.seedText = seedText;
            (metaForSave as any).extra.ctxPack.cards.seedTextLen = seedText.length;
            (metaForSave as any).extra.ctxPack.cards.seedTextHead = seedText.slice(0, 160);

            console.log('[IROS/CARDS][SEED_FROM_CARD180][OK]', {
              traceId: (metaForSave as any)?.extra?.traceId ?? (metaForSave as any)?.traceId ?? null,
              conversationId: (metaForSave as any)?.conversationId ?? null,
              userCode: (metaForSave as any)?.userCode ?? null,
              e_turn: eKey,
              depthStage: depthNow,
              polarity: polKey,
              seedLen: seedText.length,
              seedHead: seedText.slice(0, 160),
            });
          } else {
            console.warn('[IROS/CARDS][SEED_FROM_CARD180][EMPTY]', {
              e_turn: eKey,
              depthStage: depthNow,
              polarity: polKey,
            });
          }
        } catch (e) {
          console.warn('[IROS/CARDS][SEED_FROM_CARD180][ERR]', { err: String(e) });
        }
      } else {
        console.log('[IROS/CARDS][SEED_FROM_CARD180][SKIP_MISSING]', {
          e_turn: eKey,
          depthStage: depthNow ?? null,
          polarity: polKey ?? null,
        });
      }
    }
  }
} catch (e) {
  console.warn('[IROS/PP][ALWAYS_MIRROR_VS_CARDS][ERR]', { err: String(e) });
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

  {
    // 前回スナップ（orchestrator が meta.extra.viewShiftPrev に入れたもの）
    const prevSnap: any =
      (metaForSave as any)?.extra?.viewShiftPrev ??
      (metaForSave as any)?.viewShiftPrev ??
      null;

    // depth は “見えている正本” を優先（ゆれ吸収）
    const depthNow: string | null = (() => {
      const d =
        (metaForSave as any)?.depth ??
        (metaForSave as any)?.depthStage ??
        (metaForSave as any)?.framePlan?.depth ??
        (metaForSave as any)?.framePlan?.depthStage ??
        null;
      const s = typeof d === 'string' ? d.trim() : '';
      return s ? s : null;
    })();

    // e_turn は MIRROR_FLOW が入れた mirror から拾う
    const mirrorObj: any =
      (metaForSave as any)?.mirror ??
      (metaForSave as any)?.extra?.mirror ??
      (metaForSave as any)?.extra?.mirrorFlowV1?.mirror ??
      null;

    const e_turn: any = mirrorObj?.e_turn ?? null;

    // sessionBreak は ctxPack.flow（正本）優先 → extra.flow 互換
    const sessionBreakNow: any =
      (metaForSave as any)?.extra?.ctxPack?.flow?.sessionBreak ??
      (metaForSave as any)?.extra?.flow?.sessionBreak ??
      null;

    // ViewShift 判定（pure）
    const vs = computeViewShiftV1({
      userText: String(userText ?? ''),
      depth: depthNow,
      e_turn: e_turn ?? null,
      sessionBreak: sessionBreakNow ?? null,
      prev: prevSnap && typeof prevSnap === 'object' ? prevSnap : null,
    } as any);

    console.log('[IROS/VIEW_SHIFT]', {
      ok: (vs as any)?.ok ?? null,
      score: (vs as any)?.score ?? null,
      variant: (vs as any)?.variant ?? null,
      confirmLine: (vs as any)?.confirmLine ?? null,
      sessionBreak: sessionBreakNow ?? null,
    });

    // 次ターン用スナップショット（常に保存：ただし sessionBreak=true のときも “prev更新” はしてOK）
    const snap = buildViewShiftSnapshot({
      userText: String(userText ?? ''),
      depth: depthNow,
      e_turn: e_turn ?? null,
    } as any);

    // ctxPack へ保存（orchestrator が次回拾う正本）
    (metaForSave as any).extra =
      (metaForSave as any).extra && typeof (metaForSave as any).extra === 'object'
        ? (metaForSave as any).extra
        : {};

    (metaForSave as any).extra.ctxPack =
      (metaForSave as any).extra.ctxPack &&
      typeof (metaForSave as any).extra.ctxPack === 'object'
        ? (metaForSave as any).extra.ctxPack
        : {};

    (metaForSave as any).extra.ctxPack.viewShift = vs;
    (metaForSave as any).extra.ctxPack.viewShiftSnapshot = snap;

    // =========================================
    // [Phase 1] resonance cards（current/future）生成 → ctxPack.cards に保存
    // - e_turn + 現在の座標（depth/phase/stage/band）から “刺さり候補語” を作る
    // - 正本は extra.ctxPack（writer/rephrase 側が拾える）
    // =========================================
    try {
      const exAny: any = (metaForSave as any).extra ?? {};
      exAny.ctxPack = exAny.ctxPack && typeof exAny.ctxPack === 'object' ? exAny.ctxPack : {};
      (metaForSave as any).extra = exAny;

      // e_turn は MIRROR_FLOW の mirror から拾う（上で mirrorObj を作っている）
      const mirrorObjAny: any =
        (metaForSave as any)?.mirror ??
        (metaForSave as any)?.extra?.mirror ??
        (metaForSave as any)?.extra?.mirrorFlowV1?.mirror ??
        null;

      const rawETurn: any = mirrorObjAny?.e_turn ?? null;

      const normalizeETurnKey = (v: any): string | null => {
        if (v == null) return null;
        if (typeof v === 'string') {
          const s = v.trim();
          return s ? s : null;
        }
        if (typeof v === 'object') {
          // { key:'e2' } / { code:'e2' } / { e_turn:'e2' } などに耐える
          const c =
            (typeof (v as any).key === 'string' && (v as any).key.trim()) ||
            (typeof (v as any).code === 'string' && (v as any).code.trim()) ||
            (typeof (v as any).e_turn === 'string' && (v as any).e_turn.trim()) ||
            null;
          return c ? String(c).trim() : null;
        }
        return null;
      };

      const eKey = normalizeETurnKey(rawETurn); // 例: 'e1'〜'e5'
      const depthNow: string | null = (() => {
        const d =
          (metaForSave as any)?.depth ??
          (metaForSave as any)?.depthStage ??
          (metaForSave as any)?.framePlan?.depth ??
          (metaForSave as any)?.framePlan?.depthStage ??
          null;
        const s = typeof d === 'string' ? d.trim() : '';
        return s ? s : null;
      })();

      const phaseNow: string | null = (() => {
        const p =
          (metaForSave as any)?.phase ??
          (metaForSave as any)?.framePlan?.phase ??
          null;
        const s = typeof p === 'string' ? p.trim() : '';
        return s ? s : null;
      })();

      const stageNow: string | null =
        (metaForSave as any)?.coord?.stage ??
        (metaForSave as any)?.extra?.coord?.stage ??
        null;

      const bandNow: string | null =
        (metaForSave as any)?.coord?.band ??
        (metaForSave as any)?.extra?.coord?.band ??
        null;

      // --- label 生成（短く・固定・憶測しない）
      // e_turn が無い場合は “生成しない” （ここは無理に捏造しない）
      const makeLabels = (k: string) => {
        // 8〜12文字“目安”の短文（日本語は字数計測が曖昧なので「短く固定」を優先）
        const currentMap: Record<string, string> = {
          e1: 'いま整え直す',
          e2: 'いま伸ばし切る',
          e3: 'いま支え直す',
          e4: 'いま解き放つ',
          e5: 'いま灯し直す',
        };
        const futureMap: Record<string, string> = {
          e1: '次は安定が来る',
          e2: '次は成長が来る',
          e3: '次は定着が来る',
          e4: '次は浄化が来る',
          e5: '次は熱が戻る',
        };
        return {
          current: currentMap[k] ?? 'いま整え直す',
          future: futureMap[k] ?? '次は安定が来る',
        };
      };

      const makeScore = (k: string): number => {
        // 決め打ち（憶測を広げない）：eの強さとして単調増加
        if (k === 'e5') return 90;
        if (k === 'e4') return 78;
        if (k === 'e3') return 66;
        if (k === 'e2') return 54;
        if (k === 'e1') return 42;
        return 50;
      };

      if (eKey) {
        const labels = makeLabels(eKey);
        const stingScore = makeScore(eKey);

        (metaForSave as any).extra.ctxPack.cards = {
          current: {
            label: labels.current,
            // “材料”として残す（writer が回収するため）
            e_turn: eKey,
            depth: depthNow,
            phase: phaseNow,
          },
          future: {
            label: labels.future,
            e_turn: eKey,
            depth: depthNow,
            phase: phaseNow,
          },
          stingScore,
          // 追加メモ（writer が必要なら拾える）
          hint: {
            stage: stageNow,
            band: bandNow,
          },
        };

        console.log('[IROS/CARDS][GEN]', {
          ok: true,
          e_turn: eKey,
          stingScore,
          current: labels.current,
          future: labels.future,
          stage: stageNow,
          band: bandNow,
          depth: depthNow,
          phase: phaseNow,
        });
      } else {
        console.log('[IROS/CARDS][GEN]', {
          ok: false,
          reason: 'NO_E_TURN',
        });
      }
    } catch (e) {
      console.warn('[IROS/CARDS][GEN][ERR]', { err: String(e) });
    }

/* =========================================
 * [追加] resonanceState 正本 + seed_text 生成（postProcessReply 内）
 * 置き場所: ctxPack.viewShift / viewShiftSnapshot の直後
 * ========================================= */
{
  const state = buildResonanceState({
    metaForSave,
    userText: String(userText ?? ''),
  });

  // ✅ JSON セーフな snapshot 化（循環参照を断つ）
  const toJsonSafe = (input: any) => {
    const seen = new WeakSet<object>();
    try {
      return JSON.parse(
        JSON.stringify(input, (_k, v) => {
          if (typeof v === 'bigint') return String(v);
          if (typeof v === 'function') return undefined;
          if (v && typeof v === 'object') {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          return v;
        })
      );
    } catch (_e) {
      return null;
    }
  };

// ✅ 保存用の最小スナップショット（循環しない primitives のみ）
// ※ q/depth/phase は state ではなく “確定済み canon” を正本にする（null回避）
function cloneSnap(v: any) {
  if (v == null) return null;
  try {
    return typeof (globalThis as any).structuredClone === 'function'
      ? (globalThis as any).structuredClone(v)
      : JSON.parse(JSON.stringify(v));
  } catch {
    return null;
  }
}

const stateSnap = {
  rev: 'rs_snap_v1',

  qCode:
    (metaForSave as any)?.q_code ??
    (metaForSave as any)?.extra?.q_code ??
    (metaForSave as any)?.canon?.q_code ??
    (state as any)?.qCode ??
    (state as any)?.canon?.q_code ??
    null,

  depthStage:
    (metaForSave as any)?.depth_stage ??
    (metaForSave as any)?.extra?.depth_stage ??
    (metaForSave as any)?.canon?.depth_stage ??
    (state as any)?.depthStage ??
    (state as any)?.canon?.depth_stage ??
    null,

  phase:
    (metaForSave as any)?.phase ??
    (metaForSave as any)?.extra?.phase ??
    (state as any)?.phase ??
    null,

  seed_text:
    typeof (state as any)?.seed?.seed_text === 'string'
      ? (state as any).seed.seed_text.trim()
      : null,

  // instant（このターンの反応）
  e_turn: (state as any)?.instant?.mirror?.e_turn ?? (state as any)?.instant?.e_turn ?? null,
  mirror_confidence: (state as any)?.instant?.mirror?.confidence ?? null,

  flow_delta: (state as any)?.instant?.flow?.delta ?? null,
  flow_returnStreak: (state as any)?.instant?.flow?.returnStreak ?? null,

  // cards（あれば）
  currentCard: {
    cardId: (state as any)?.cards?.current?.cardId ?? null,
    meaningKey: (state as any)?.cards?.current?.meaningKey ?? null,
    shortText: (state as any)?.cards?.current?.shortText ?? null,
  },
  futureCard: {
    cardId: (state as any)?.cards?.future?.cardId ?? null,
    meaningKey: (state as any)?.cards?.future?.meaningKey ?? null,
    shortText: (state as any)?.cards?.future?.shortText ?? null,
    source: (state as any)?.cards?.future?.source ?? null,
  },
};

// ----------------------------------------
// meta へ保存（循環防止） + 互換 seed_text
// - extra.resonanceState は “正本”
// - extra.ctxPack.resonanceState は “別参照 clone”（同一参照だと seen 判定で "[Circular]" になりうる）
// ----------------------------------------
(metaForSave as any).extra = (metaForSave as any).extra ?? {};
(metaForSave as any).extra.ctxPack = (metaForSave as any).extra.ctxPack ?? {};

// ✅ 正本：snapshot を保存
(metaForSave as any).extra.resonanceState = stateSnap;

// ✅ 互換：seed_text（RESONANCE_STATE 判定 & 旧キー拾いのため）
if (
  (metaForSave as any).extra.seed_text == null &&
  typeof stateSnap.seed_text === 'string' &&
  stateSnap.seed_text.trim()
) {
  (metaForSave as any).extra.seed_text = stateSnap.seed_text.trim();
}

// ✅ 次ターン用：ctxPack には別参照 clone
(metaForSave as any).extra.ctxPack.resonanceState = cloneSnap(stateSnap);

// ✅ ctxPack 側にも seed_text（rephraseEngine の拾い口を太くする）
if (
  (metaForSave as any).extra.ctxPack.seed_text == null &&
  typeof stateSnap.seed_text === 'string' &&
  stateSnap.seed_text.trim()
) {
  (metaForSave as any).extra.ctxPack.seed_text = stateSnap.seed_text.trim();
}

// =============================
// デバッグログ（SEED材料確認用）
// =============================
console.log('[IROS/PP][RS_SNAPSHOT]', {
  qCode: stateSnap.qCode,
  depthStage: stateSnap.depthStage,
  phase: stateSnap.phase,
  e_turn: stateSnap.e_turn,
  mirror_confidence: stateSnap.mirror_confidence,
  flow_delta: stateSnap.flow_delta,
  flow_returnStreak: stateSnap.flow_returnStreak,
  seedLen: typeof stateSnap.seed_text === 'string' ? stateSnap.seed_text.length : 0,
  seedHead: String(stateSnap.seed_text ?? '').slice(0, 96),
  futureCard: stateSnap.futureCard?.cardId ?? null,
});
/* =========================================
 * [置換] resonanceState 保存（snapshot / 別参照 clone）
 * 目的: extra.resonanceState と extra.ctxPack.resonanceState を同一参照にしない
 *       → persist の seen 判定で "[Circular]" にならない
 * ========================================= */

(metaForSave as any).extra = (metaForSave as any).extra ?? {};

// ✅ 正本：meta.extra に置く（snapshot だけ）
(metaForSave as any).extra.resonanceState = stateSnap;

// ✅ 次ターン用：ctxPack には “別参照” を置く（同一参照だと "[Circular]" になる）
(metaForSave as any).extra.ctxPack = (metaForSave as any).extra.ctxPack ?? {};
// ✅ 正本：ctxPack.flow を必ず埋める（snapshot 優先）
// - DB の has_flowdelta/has_returnstreak が assistant 側で落ちる原因は
//   ctxPack.flow が未保存 & meta.flow の dd/rr が null になるケースがあるため。
{
  const flowDeltaSnap =
    (stateSnap as any)?.flow_delta ??
    (state as any)?.instant?.flow?.delta ??
    null;

  const returnStreakSnap =
    (stateSnap as any)?.flow_returnStreak ??
    (state as any)?.instant?.flow?.returnStreak ??
    null;

  // sessionBreak/ageSec は既に他所で解決されている前提だが、
  // ctxPack.flow にも寄せて “正本” を太くしておく
  const sessionBreakSnap =
    (metaForSave as any)?.extra?.ctxPack?.flow?.sessionBreak ??
    (metaForSave as any)?.extra?.flow?.sessionBreak ??
    (state as any)?.instant?.flow?.sessionBreak ??
    null;

  const ageSecSnap =
    (metaForSave as any)?.extra?.ctxPack?.flow?.ageSec ??
    (metaForSave as any)?.extra?.flow?.ageSec ??
    (state as any)?.instant?.flow?.ageSec ??
    null;

  (metaForSave as any).extra.ctxPack = (metaForSave as any).extra.ctxPack ?? {};
  (metaForSave as any).extra.ctxPack.flow = (metaForSave as any).extra.ctxPack.flow ?? {};

  // delta は “delta” 名で保持（既存コードの参照形に合わせる）
  if ((metaForSave as any).extra.ctxPack.flow.delta == null && flowDeltaSnap != null) {
    (metaForSave as any).extra.ctxPack.flow.delta = flowDeltaSnap;
  }
  if ((metaForSave as any).extra.ctxPack.flow.returnStreak == null && returnStreakSnap != null) {
    (metaForSave as any).extra.ctxPack.flow.returnStreak = returnStreakSnap;
  }
  if ((metaForSave as any).extra.ctxPack.flow.sessionBreak == null && sessionBreakSnap != null) {
    (metaForSave as any).extra.ctxPack.flow.sessionBreak = sessionBreakSnap;
  }
  if ((metaForSave as any).extra.ctxPack.flow.ageSec == null && ageSecSnap != null) {
    (metaForSave as any).extra.ctxPack.flow.ageSec = ageSecSnap;
  }
}
(metaForSave as any).extra.ctxPack.resonanceState = cloneSnap(stateSnap);
  // ✅ 互換：meta.flow にも returnStreak を併記してズレ再発を防ぐ（正本は ctxPack.flow）
  // 優先順：ctxPack.flow（正本）→ extra.flow（互換）→ state.instant.flow（最後の保険）
  {
    const ctxFlow =
      (metaForSave as any)?.extra?.ctxPack?.flow &&
      typeof (metaForSave as any).extra.ctxPack.flow === 'object'
        ? (metaForSave as any).extra.ctxPack.flow
        : null;

    const exFlow =
      (metaForSave as any)?.extra?.flow && typeof (metaForSave as any).extra.flow === 'object'
        ? (metaForSave as any).extra.flow
        : null;

    const rr =
      ctxFlow?.returnStreak ??
      exFlow?.returnStreak ??
      (state as any)?.instant?.flow?.returnStreak ??
      null;

    const dd =
      ctxFlow?.delta ??
      exFlow?.delta ??
      (state as any)?.instant?.flow?.delta ??
      null;

    if (rr != null || dd != null) {
      (metaForSave as any).flow = (metaForSave as any).flow ?? {};
      if ((metaForSave as any).flow.delta == null && dd != null) (metaForSave as any).flow.delta = dd;
      if ((metaForSave as any).flow.returnStreak == null && rr != null) (metaForSave as any).flow.returnStreak = rr;
    }
  }


      console.log('[IROS/PP][RESONANCE_STATE]', {
        traceId:
        (metaForSave as any)?.extra?.traceId ??
        (metaForSave as any)?.extra?.ctxPack?.traceId ??
        null,
        conversationId,
        userCode,
        hasSeed: Boolean((metaForSave as any)?.extra?.seed_text),
        seedHead: String((metaForSave as any)?.extra?.seed_text ?? '').slice(0, 96),

        // --- flow source probes (確証用) ---
        flowDelta_state: state?.instant?.flow?.delta ?? null,
        returnStreak_state: state?.instant?.flow?.returnStreak ?? null,

        flowDelta_metaExtraCtx: (metaForSave as any)?.extra?.ctxPack?.flow?.delta ?? null,
        returnStreak_metaExtraCtx: (metaForSave as any)?.extra?.ctxPack?.flow?.returnStreak ?? null,

        flowDelta_metaFlow: (metaForSave as any)?.flow?.delta ?? null,
        returnStreak_metaFlow: (metaForSave as any)?.flow?.returnStreak ?? null,

        flowDelta_extraFlow: (metaForSave as any)?.extra?.flow?.delta ?? null,
        returnStreak_extraFlow: (metaForSave as any)?.extra?.flow?.returnStreak ?? null,

        // mirror_flow（参考）
        e_turn: state?.instant?.e_turn ?? null,
      });
    }

    console.log('[IROS/VIEWSHIFT][DECISION]', {
      ok: vs?.ok ?? false,
      score: vs?.score ?? 0,
      variant: vs?.variant ?? null,
      sessionBreak: sessionBreakNow ?? null,
    });
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


        // ✅ micro は ExpressionLane 決定より前に確定して渡す（micro抑制を効かせる）
        const microNowExpr = Boolean((metaForSave as any)?.extra?.mirrorFlowV1?.flow?.micro);

        const d = decideExpressionLane({
          laneKey,
          phase,
          depth,
          allow,
          exprAllow,
          flow: { flowDelta: flowDelta ?? null, returnStreak: returnStreak ?? null, micro: microNowExpr },
          signals,
          flags,
          traceId: (metaForSave as any)?.traceId ?? null,
        } as any);


// metaPatch は 1回だけ merge
if (d?.metaPatch && typeof d.metaPatch === 'object') {
  metaForSave.extra = { ...(metaForSave.extra ?? {}), ...d.metaPatch };
}
// ✅ exprDecision は従来どおり保存しつつ、
// ✅ ctxPack.expr / ctxPack.exprMeta（正本）に fired/lane/reason/prefaceLine を合流して systemPrompt へ届ける
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

  // 既存の expr（prefaceLine 等）も拾う（DIRECTIVE は ctxPack.expr を参照する）
  const prevExpr: any =
    (prevCtxPack?.expr && typeof prevCtxPack.expr === 'object' ? prevCtxPack.expr : null) ??
    (prevExtra?.expr && typeof prevExtra.expr === 'object' ? prevExtra.expr : null) ??
    {};

  const fired = Boolean((d as any)?.fired);
  const lane = String((d as any)?.lane ?? 'off');
  const reason = String((d as any)?.reason ?? 'DEFAULT');

  let prefaceLine = String((d as any)?.prefaceLine ?? '').trim();

  // ViewShift confirmLine（1行）を “空のときだけ” 差し込む
  if (!prefaceLine) {
    const vsConfirm: string | null =
      (metaForSave as any)?.extra?.ctxPack?.viewShift?.confirmLine ??
      (metaForSave as any)?.extra?.viewShift?.confirmLine ??
      null;

    if (typeof vsConfirm === 'string' && vsConfirm.trim().length > 0) {
      prefaceLine = vsConfirm.trim();
    }
  }

  // ✅ null に正規化（空文字は持たない）
  const prefaceLineOrNull = prefaceLine ? prefaceLine : null;

  // ✅ ctxPack 正本に合流（expr / exprMeta を両方揃える）
  const nextCtxPack = {
    ...(prevCtxPack ?? {}),
    expr: {
      ...(prevExpr ?? {}),
      fired,
      lane,
      reason,
      prefaceLine: prefaceLineOrNull,
    },
    exprMeta: {
      ...(prevExprMeta ?? {}),
      fired,
      lane,
      reason,
      prefaceLine: prefaceLineOrNull,
    },
  };

  prevExtra.ctxPack = nextCtxPack;

  // ✅ 互換：古い extra.expr / extra.exprMeta を残す（必要なら）
  // ただし「正本は ctxPack」とする
  prevExtra.expr = nextCtxPack.expr;
  prevExtra.exprMeta = nextCtxPack.exprMeta;


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
  const polRaw = mirrorObj?.polarity_out ?? mirrorObj?.polarity ?? null;
  const pol = (typeof polRaw === 'string' ? polRaw : '').trim(); // yin/yang など（objectは捨てる）

  const userTextNow =
    String((metaForSave as any)?.userText ?? '').trim() ||
    String((metaForSave as any)?.text ?? '').trim() ||
    '';

  if (typeof directiveV1 === 'string' && directiveV1.trim()) {
    const extraLines: string[] = [
      // ✅ ViewShift の目的に合わせる：prefaceLine を「毎回強制」しない
      // - prefaceLine は postprocess 側で確定（ViewShift.confirmLine を拾う）
      // - Writer は prefaceLine を“追加生成しない”

      et
        ? `材料：ユーザー発話と e_turn（${et}）${pol ? ` と polarity（${pol}）` : ''}。ただし e_turn/polarity のラベルは本文に出さない。`
        : '材料：ユーザー発話。内部ラベルは本文に出さない。',
      '禁止：状況説明や共感の羅列。焦点（何が削られているか／何が残っているか）だけを一点に絞る。',
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

/* =========================================
 * [置換] src/lib/iros/server/handleIrosReply.postprocess.ts
 * 範囲: 1296〜1310 を丸ごと置き換え
 * 目的:
 * - prefaceLine/prefaceHead を「正本 ctxPack」に必ず載せる
 * - renderGateway / systemPrompt どちらの拾い方でも落ちないようにする
 * ========================================= */
    // ✅ 正本：handleIrosReply.ts がここから同期する
      // ✅ NEW: Mirror（e_turn/polarity/confidence）を ctxPack 正本へ
      // rephraseEngine 側は ctxPack.mirror を優先的に読む
      mirror: (mirrorObj && typeof mirrorObj === 'object') ? mirrorObj : (prevCtxPack as any)?.mirror ?? null,

      // ✅ NEW: 互換（将来カードseed側が top-level を読む場合に備える）
      e_turn: (mirrorObj as any)?.e_turn ?? (prevCtxPack as any)?.e_turn ?? null,
      polarity: (mirrorObj as any)?.polarity ?? (prevCtxPack as any)?.polarity ?? null,
      mirrorConfidence:
        (mirrorObj as any)?.confidence ?? (mirrorObj as any)?.polarity_confidence ?? (prevCtxPack as any)?.mirrorConfidence ?? null,

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

// ✅ preface は exprDecision ではなく「正本：exprMeta」から拾う
const preface = String((metaForSave as any)?.extra?.exprMeta?.prefaceLine ?? '').trim();

const mfNow =
  (metaForSave as any)?.extra?.mirrorFlow ??
  (metaForSave as any)?.mirrorFlow ??
  (metaForSave as any)?.mirror_flow ??
  null;

const microNow = Boolean(mfNow?.flow?.micro);

const shouldInjectPreface =
  preface.length > 0 &&
  !slotTextStr.startsWith(preface) &&
  !microNow;

let seedForWriterRaw = shouldInjectPreface ? `${preface}\n${slotTextStr}` : slotTextStr;

// ✅ NEW: Concept Lock (RECALL) を seed の先頭に強制注入（PPが llmRewriteSeed を上書きしても残る）
try {
  const cr: any = (metaForSave as any)?.extra?.conceptRecall ?? null;
  const items: string[] =
    cr && typeof cr === 'object' && cr.active === true && Array.isArray(cr.items)
      ? cr.items.map((s: any) => String(s ?? '').trim()).filter(Boolean)
      : [];

  const userTextNow = String(userText ?? '').trim();
  const wantsRecall =
    !!userTextNow &&
    /(３つ|三つ|3つ|その3つ|この3つ|それ|それは|あれ|あれは|って何|とは|何ですか|なんですか)/.test(userTextNow);

  if (!microNow && wantsRecall && items.length >= 3) {
    const head3 = items.slice(0, 3);
    const lockLine = `概念固定：この会話の「3つ」は ${head3.join(' / ')}。否認せず、まず3つを先に出してから説明する。`;
    if (!seedForWriterRaw.includes(lockLine)) {
      seedForWriterRaw = `${lockLine}\n${seedForWriterRaw}`.trim();
    }
    const seedLine = `@SEED_TEXT ${JSON.stringify({ text: lockLine })}`;
    if (!seedForWriterRaw.includes(seedLine)) {
      seedForWriterRaw = `${seedForWriterRaw}\n${seedLine}`.trim();
    }
  }
} catch {}
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
        // writer に委ねる（UI本文は空に固定し、seedは meta にだけ持つ）
        let baseVisible =
          String(seedForWriterSanitized ?? '').trim() || String(coreLine ?? '').trim() || '';

        // FINAL で "hint " から始まるものは UI 露出禁止（空にする）
        if (det?.policy === 'FINAL' && baseVisible.trim().startsWith('hint ')) {
          baseVisible = '';
        }

        // ✅ 重要：ここで本文に入れない（seed-only）
        finalAssistantText = '';

        metaForSave.extra = {
          ...(metaForSave.extra ?? {}),
          // FINAL だが “本文はwriterが作る” ので commit ではなく defer にする
          finalTextPolicy: 'FINAL__LLM_DEFER',
          slotPlanCommitted: false,

          // ✅ seed-only: writer に渡す seed を meta に載せる（UI本文にはしない）
          slotPlanSeed: baseVisible, // ← runLlmGate の seedFallback が拾う
          slotPlanSeedLen: baseVisible.length,
          slotPlanSeedHead: baseVisible.slice(0, 64),

          // 観測用：seed は meta に残す（UI本文にはしない）
          baseVisibleLen: baseVisible.length,
          baseVisibleHead: baseVisible.slice(0, 64),
          baseVisibleSource: String(seedForWriterSanitized ?? '').trim()
            ? 'seedForWriterSanitized'
            : 'coreLine(lastResort)',
        };

        console.log('[IROS/PostProcess] SLOTPLAN_SEED_TO_WRITER (seed only; no commit)', {
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
// ✅ Iros 文体 正規化フィルタ（final統合点）
// - レーン/スロット/Q帯に依存せず、最終文体だけを自然化する
{
  const seed =
    String((metaForSave as any)?.extra?.traceId ?? '') ||
    String((metaForSave as any)?.extra?.ctxPack?.traceId ?? '') ||
    String(conversationId ?? '');

  // --- lane（sofia_light 等）を拾う：ctxPack.exprMeta を正本として見る ---
  const exprLane: string | null =
    (metaForSave as any)?.extra?.ctxPack?.exprMeta?.lane ??
    (metaForSave as any)?.extra?.ctxPack?.expr?.lane ??
    (metaForSave as any)?.extra?.exprMeta?.lane ??
    (metaForSave as any)?.extra?.exprDecision?.lane ??
    null;

  // --- 「3段以上」判定（空行区切り優先、なければ改行を段として数える）---
  const raw = String(finalAssistantText ?? '');
  const parasByBlank = raw
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  const paraCount =
    parasByBlank.length > 0
      ? parasByBlank.length
      : raw
          .split(/\n+/)
          .map((s) => s.trim())
          .filter(Boolean).length;

  // --- 絵文字の扱い（LLMの装飾を殺さない）---
  // ✅ iros の共鳴UIでは「絵文字は剥がさない」を正とする
  // - sofia_light: 当然剥がさない
  // - それ以外も、剥がすと体験が壊れるため keep=1.0 に固定
  const emojiKeepRate = 1.0;

  const n = normalizeIrosStyleFinal(finalAssistantText, {
    seed,
    emojiKeepRate,
    maxReplacements: 5,
  });

  finalAssistantText = n.text;

  // 任意：デバッグ用（必要なら残す。重いなら消してOK）
  (metaForSave.extra as any) = {
    ...(metaForSave.extra ?? {}),
    styleNormFinal: {
      ...(n.meta ?? {}),
      pickedEmojiKeepRate: emojiKeepRate,
      pickedExprLane: exprLane,
      pickedParaCount: paraCount,
    },
  };
}
    const finalText = String(finalAssistantText ?? '').trim();
    const prevRaw = String(ex?.rawTextFromModel ?? '').trim();

    ex.extractedTextFromModel = finalText;

    if (!prevRaw && finalText) {
      ex.rawTextFromModel = finalText;
    }
  }
} catch (e) {
  console.warn('[IROS/PostProcess] extractedTextFromModel patch failed (non-fatal)', {
    userCode,
    conversationId,
    err: String(e),
  });
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
