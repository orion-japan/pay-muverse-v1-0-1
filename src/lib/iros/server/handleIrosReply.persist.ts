// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (single-writer + memory_state)

import type { SupabaseClient } from '@supabase/supabase-js';

// ✅ アンカー汚染判定は「共通の唯一」を使う（重複定義しない）
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';

/* =========================
 * Types
 * ========================= */

type Phase = 'Inner' | 'Outer';
type SpinLoop = 'SRI' | 'TCF';
type DescentGate = 'closed' | 'offered' | 'accepted';
type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

// ✅ q_counts は「it_cooldown」等の付帯情報を含み得る（jsonb）
type QCounts = {
  it_cooldown?: number; // 0/1
  q_trace?: any; // 観測用（DB列追加なしで調査できる）
  it_triggered?: boolean;
  it_triggered_true?: boolean;
  [k: string]: any;
};

type PrevMemoryState = {
  q_counts?: any;
  depth_stage?: string | null;
  q_primary?: string | null;
  phase?: string | null;
  intent_layer?: string | null;
  self_acceptance?: number | null;
  y_level?: number | null;
  h_level?: number | null;
  spin_loop?: string | null;
  spin_step?: number | null;
  descent_gate?: string | null;
  intent_anchor?: any;
  summary?: string | null;
  situation_summary?: string | null;
  situation_topic?: string | null;
  sentiment_level?: any;
} | null;

/* =========================
 * Helpers (minimal / noUnusedLocals-safe)
 * ========================= */

function nowIso(): string {
  return new Date().toISOString();
}

function toInt0to3(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3, Math.round(v)));
}

function normalizePhase(v: unknown): Phase | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().toLowerCase();
  if (p === 'inner') return 'Inner';
  if (p === 'outer') return 'Outer';
  return null;
}

function normalizeSpinLoop(v: unknown): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'SRI') return 'SRI';
  if (s === 'TCF') return 'TCF';
  return null;
}

function normalizeSpinStep(v: unknown): 0 | 1 | 2 | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n === 0 || n === 1 || n === 2) return n;
  return null;
}

// ✅ boolean互換あり（Aの確定）
function normalizeDescentGate(v: unknown): DescentGate | null {
  if (v == null) return null;

  // 互換: boolean が来たら
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'closed') return 'closed';
  if (s === 'offered') return 'offered';
  if (s === 'accepted') return 'accepted';
  return null;
}

function normalizeQCounts(v: unknown): QCounts {
  if (!v || typeof v !== 'object') return { it_cooldown: 0 };
  const obj = v as any;
  const cd = typeof obj.it_cooldown === 'number' ? obj.it_cooldown : 0;
  return { ...(obj ?? {}), it_cooldown: cd > 0 ? 1 : 0 };
}

function normalizeAnchorText(text: string): string {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** intent_anchor から text を安全に取り出す */
function extractAnchorText(anchor: any): string | null {
  if (!anchor) return null;
  if (typeof anchor === 'string') return anchor.trim() || null;
  if (typeof anchor === 'object') {
    const t = (anchor as any).text;
    if (typeof t === 'string') return t.trim() || null;
  }
  return null;
}

/**
 * “アンカー更新イベント” を meta から拾う
 * - metaForSave.anchorEvent.type を最優先
 * - 互換として anchorEventType も拾う
 */
function pickAnchorEventType(metaForSave: any): AnchorEventType {
  const t1 = metaForSave?.anchorEvent?.type;
  if (t1 === 'none' || t1 === 'confirm' || t1 === 'set' || t1 === 'reset') return t1;

  const t2 = metaForSave?.anchorEventType;
  if (t2 === 'none' || t2 === 'confirm' || t2 === 'set' || t2 === 'reset') return t2;

  return 'none';
}

/**
 * ✅ intent_anchor 保存ゲート（合意仕様）
 * - DB上のアンカーは「北極星」なので、通常ターンでは更新しない
 * - 更新できるのは set/reset のときだけ
 * - confirm は「表に出す」だけで、DB更新はしない
 *
 * 追加安全策：
 * - reset は「消す」なので anchorText 不要
 * - メタ発話は set でも絶対拒否
 */
function shouldWriteIntentAnchorToMemoryState(args: {
  anchorEventType: AnchorEventType;
  anchorText: string | null;
}): { action: 'keep' | 'set' | 'reset' } {
  const { anchorEventType, anchorText } = args;

  if (anchorEventType === 'reset') return { action: 'reset' };
  if (anchorEventType !== 'set') return { action: 'keep' };

  if (!anchorText) return { action: 'keep' };
  if (isMetaAnchorText(anchorText)) return { action: 'keep' };

  return { action: 'set' };
}

function pickFirstString(...cands: any[]): string | null {
  for (const v of cands) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * ✅ previous memory_state を「環境差（列欠損）」に強く読む
 * - 42703(未定義カラム) の場合、列を落として再試行
 */
async function safeLoadPreviousMemoryState(
  supabase: SupabaseClient,
  userCode: string,
): Promise<PrevMemoryState> {
  const baseCols = [
    'q_counts',
    'depth_stage',
    'q_primary',
    'phase',
    'intent_layer',
    'self_acceptance',
    'y_level',
    'h_level',
    'spin_loop',
    'spin_step',
    'intent_anchor',
    'summary',
    'situation_summary',
    'situation_topic',
    'sentiment_level',
  ];

  const withDescent = [...baseCols, 'descent_gate'];

  // 1st try (with descent_gate)
  {
    const { data, error } = await supabase
      .from('iros_memory_state')
      .select(withDescent.join(','))
      .eq('user_code', userCode)
      .maybeSingle();

    if (!error) return (data as any) ?? null;

    const code = (error as any)?.code;
    const msg = String((error as any)?.message ?? '');

    // 42703: drop descent_gate and retry
    if (code === '42703' && /descent_gate/i.test(msg)) {
      console.warn('[IROS/STATE] previous select missing descent_gate. retry without it.', {
        userCode,
        code,
        message: msg,
      });
    } else {
      console.warn('[IROS/STATE] load previous memory_state not ok (continue)', {
        userCode,
        code,
        message: msg,
      });
      return null;
    }
  }

  // retry (base)
  {
    const { data, error } = await supabase
      .from('iros_memory_state')
      .select(baseCols.join(','))
      .eq('user_code', userCode)
      .maybeSingle();

    if (error) {
      console.warn('[IROS/STATE] load previous memory_state retry not ok (continue)', {
        userCode,
        code: (error as any)?.code,
        message: (error as any)?.message,
      });
      return null;
    }
    return (data as any) ?? null;
  }
}

/* =========================
 * Persist: messages
 * ========================= */
// ✅ single-writer 固定：assistant は絶対に保存しない（route.ts が唯一の保存者）
export async function persistAssistantMessage(args: {
  supabase: SupabaseClient; // 使わない（呼び出し統一のため受け取る）
  reqOrigin: string;
  authorizationHeader: string | null;
  conversationId: string;
  userCode: string;
  assistantText: string;
  metaForSave: any;
  content?: string;
  renderedContent?: string;
}) {
  const { conversationId, userCode } = args;

  console.log('[IROS/persistAssistantMessage] HARD-SKIP (single-writer route.ts)', {
    conversationId,
    userCode,
  });

  return {
    ok: true,
    skipped: true,
    reason: 'SINGLE_WRITER__ASSISTANT_PERSISTED_BY_ROUTE_ONLY',
  } as any;
}

/* =========================
 * Persist: Q snapshot
 * ========================= */

export async function persistQCodeSnapshotIfAny(args: {
  userCode: string;
  conversationId: string;
  requestedMode: string | undefined;
  metaForSave: any;
}) {
  const { userCode, conversationId, requestedMode, metaForSave } = args;

  try {
    const root: any = metaForSave ?? null;

    // metaForSave の形が複数あり得るので “実体” を探す
    const core: any = root?.meta ?? root?.finalMeta ?? root;
    const unified: any = core?.unified ?? null;

    // ---- Q を “絶対に拾う” 優先順 ----
    const q: any =
      core?.qCode ??
      core?.q_code ??
      core?.qPrimary ??
      core?.q_now ??
      core?.qTraceUpdated?.qNow ??
      core?.qTrace?.qNow ??
      core?.q_counts?.q_trace?.qNow ??
      unified?.q?.current ??
      unified?.qCode ??
      null;

    // ---- Depth stage を拾う ----
    const stage: any =
      core?.depth ??
      core?.depth_stage ??
      core?.depthStage ??
      unified?.depth?.stage ??
      null;

    // layer/polarity（安全デフォルト）
    const phase = normalizePhase(core?.phase ?? unified?.phase ?? null);
    const layer: any = phase === 'Outer' ? 'outer' : 'inner';
    const polarity: any = (unified as any)?.polarityBand ?? 'now';

    if (q) {
      const { writeQCodeWithEnv } = await import('@/lib/qcode/qcode-adapter');

      await writeQCodeWithEnv({
        user_code: userCode,
        source_type: 'iros',
        intent: requestedMode ?? 'auto',
        q,
        stage,
        layer,
        polarity,
        conversation_id: conversationId,
        created_at: nowIso(),
        extra: {
          _from: 'handleIrosReply.persist',
          _picked_from: {
            has_qCode: !!core?.qCode,
            has_q_code: !!core?.q_code,
            has_qPrimary: !!core?.qPrimary,
            has_unified_current: !!unified?.q?.current,
            has_qTraceUpdated: !!core?.qTraceUpdated,
          },
        },
      });
    } else {
      console.warn('[IROS/Q] skip persistQCodeSnapshotIfAny because q is null', {
        userCode,
        conversationId,
        requestedMode,
        keys_core: core ? Object.keys(core) : null,
        qCode: core?.qCode ?? null,
        q_code: core?.q_code ?? null,
        qPrimary: core?.qPrimary ?? null,
        qTraceUpdated: core?.qTraceUpdated ?? null,
        unifiedCurrent: unified?.q?.current ?? null,
        unifiedDepth: unified?.depth?.stage ?? null,
      });
    }
  } catch (e) {
    console.error('[IROS/Q] persistQCodeSnapshotIfAny failed', e);
  }
}

/* =========================
 * Persist: intent_anchor (reserved)
 * ========================= */

export async function persistIntentAnchorIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  metaForSave: any;
}) {
  // NOTE:
  // intent_anchor は現状 iros_memory_state.intent_anchor(jsonb) に保存する設計に寄せる。
  // ここは「専用テーブル」等に分離したくなったら移植する。
  return;
}

/* =========================
 * Persist: iros_memory_state
 * ========================= */

export async function persistMemoryStateIfAny(args: {
  supabase: SupabaseClient;
  userCode: string;
  userText: string;
  metaForSave: any;

  // ✅ 任意：q_counts を外から渡せる
  qCounts?: unknown | null;

  // ✅ 任意：そのターンで IT が発火したか（最優先）
  itTriggered?: boolean;
}) {
  const { supabase, userCode, userText, metaForSave, qCounts, itTriggered } = args;

  try {
    if (!metaForSave) return;

    // =========================================================
    // ✅ metaForSave の形ゆれを吸収
    // =========================================================
    const root: any = metaForSave ?? null;
    const core: any = root?.meta ?? root?.finalMeta ?? root;
    const unified: any = core?.unified ?? {};
    const extra: any = root?.extra ?? core?.extra ?? null;

    // =========================================================
    // previous（環境差に強い読み）
    // =========================================================
    const previous = await safeLoadPreviousMemoryState(supabase, userCode);

    // =========================================================
    // q / depth（取りこぼし防止：core/unified）
    // =========================================================
    const qCodeInput =
      unified?.q?.current ?? core?.qPrimary ?? core?.q_code ?? core?.qCode ?? null;

    const depthInput =
      unified?.depth?.stage ?? core?.depth ?? core?.depth_stage ?? core?.depthStage ?? null;

    // 保存する意味がある最低条件
    if (!depthInput && !qCodeInput) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', { userCode });
      return;
    }

    // =========================================================
    // ITX（Intent Transition）: core/extra/unified から確定値を拾う
    // =========================================================
    const stepRaw =
      core?.itx_step ??
      core?.itxStep ??
      core?.itx?.step ??
      extra?.itx_step ??
      extra?.itxStep ??
      extra?.itx?.step ??
      unified?.itx_step ??
      unified?.itxStep ??
      unified?.itx?.step ??
      null;

    const anchorRaw =
      core?.itx_anchor_event_type ??
      core?.itxAnchorEventType ??
      core?.itx?.anchorEventType ??
      core?.anchorEventType ??
      extra?.itx_anchor_event_type ??
      extra?.itxAnchorEventType ??
      extra?.itx?.anchorEventType ??
      extra?.anchorEventType ??
      unified?.itx_anchor_event_type ??
      unified?.itxAnchorEventType ??
      unified?.itx?.anchorEventType ??
      unified?.anchorEventType ??
      null;

    const reasonRaw =
      core?.itx_reason ??
      core?.itxReason ??
      core?.itx?.reason ??
      core?.itReason ??
      extra?.itx_reason ??
      extra?.itxReason ??
      extra?.itx?.reason ??
      extra?.itReason ??
      unified?.itx_reason ??
      unified?.itxReason ??
      unified?.itx?.reason ??
      null;

    const lastAtRaw =
      core?.itx_last_at ??
      core?.itxLastAt ??
      core?.itx?.lastAt ??
      extra?.itx_last_at ??
      extra?.itxLastAt ??
      extra?.itx?.lastAt ??
      unified?.itx_last_at ??
      unified?.itxLastAt ??
      unified?.itx?.lastAt ??
      null;

    const tHint =
      typeof stepRaw === 'string'
        ? stepRaw.trim().toUpperCase()
        : typeof stepRaw === 'number'
          ? String(stepRaw).trim().toUpperCase()
          : '';

    const stepFinal: 'T1' | 'T2' | 'T3' | null =
      tHint === 'T1' || tHint === 'T2' || tHint === 'T3' ? (tHint as any) : null;

    const a = typeof anchorRaw === 'string' ? anchorRaw.trim().toLowerCase() : '';
    const anchorFinal: AnchorEventType | null =
      a === 'none' || a === 'confirm' || a === 'set' || a === 'reset' ? (a as any) : null;

    const reasonFinal =
      typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;

    const lastAtFinal =
      typeof lastAtRaw === 'string' && lastAtRaw.trim().length > 0 ? lastAtRaw.trim() : null;

    // --- IT発火（renderModeから推定しない）---
    const itTriggeredResolved: boolean | null =
      typeof itTriggered === 'boolean'
        ? itTriggered
        : typeof core?.itTriggered === 'boolean'
          ? core.itTriggered
          : typeof extra?.itTriggered === 'boolean'
            ? extra.itTriggered
            : null;

    const itTriggeredForCounts = itTriggeredResolved === true;

    // =========================================================
    // QTrace（persistでは“再計算しない” / ただし1固定事故だけ防ぐ）
    // =========================================================
    const prevQ = (previous as any)?.q_primary ?? null;

    const qtu = core?.qTraceUpdated;
    const qtuLen =
      typeof qtu?.streakLength === 'number' && Number.isFinite(qtu.streakLength)
        ? Math.max(0, Math.floor(qtu.streakLength))
        : null;

    const qt = core?.qTrace;
    const qtLen =
      typeof qt?.streakLength === 'number' && Number.isFinite(qt.streakLength)
        ? Math.max(0, Math.floor(qt.streakLength))
        : null;

    let streakQ: string | null = null;
    let streakLength: number | null = null;
    let streakFrom: 'qTraceUpdated' | 'qTrace' | 'fallback' | 'none' = 'none';

    if (qCodeInput) {
      const sameAsPrev = prevQ != null && prevQ === qCodeInput;

      if (qtuLen != null) {
        streakQ = qCodeInput;
        streakLength = Math.max(qtuLen, sameAsPrev ? 2 : 1);
        streakFrom = 'qTraceUpdated';
      } else if (qtLen != null) {
        streakQ = qCodeInput;
        streakLength = Math.max(qtLen, sameAsPrev ? 2 : 1);
        streakFrom = 'qTrace';
      } else {
        streakQ = qCodeInput;
        streakLength = sameAsPrev ? 2 : 1;
        streakFrom = 'fallback';
      }
    } else {
      streakFrom = 'none';
    }

    const qTraceForCounts = qCodeInput
      ? { prevQ, qNow: qCodeInput, streakQ, streakLength, from: streakFrom }
      : null;

    // =========================================================
    // 基本入力（core/unified）
    // =========================================================
    const phaseRawInput = core?.phase ?? unified?.phase ?? null;
    const phaseInput = normalizePhase(phaseRawInput);

    const selfAcceptanceInput =
      core?.selfAcceptance ?? unified?.selfAcceptance ?? unified?.self_acceptance ?? null;

    const yIntInput = toInt0to3(core?.yLevel ?? unified?.yLevel);
    const hIntInput = toInt0to3(core?.hLevel ?? unified?.hLevel);

    const situationSummaryInput =
      core?.situationSummary ?? unified?.situation?.summary ?? core?.situation_summary ?? null;

    const situationTopicInput =
      core?.situationTopic ?? unified?.situation?.topic ?? core?.situation_topic ?? null;

    const sentimentLevelInput =
      core?.sentimentLevel ?? core?.sentiment_level ?? unified?.sentiment_level ?? null;

    // =========================================================
    // spin / descentGate（normalize → merge）
    // =========================================================
    const spinLoopRawInput =
      core?.spinLoop ?? core?.spin_loop ?? unified?.spin_loop ?? unified?.spinLoop ?? null;

    const spinStepRawInput =
      core?.spinStep ?? core?.spin_step ?? unified?.spin_step ?? unified?.spinStep ?? null;

    const descentGateRawInput =
      core?.descentGate ??
      core?.descent_gate ??
      unified?.descent_gate ??
      unified?.descentGate ??
      null;

    const spinLoopNormInput = normalizeSpinLoop(spinLoopRawInput);
    const spinStepNormInput = normalizeSpinStep(spinStepRawInput);
    const descentGateNormInput = normalizeDescentGate(descentGateRawInput);

    const spinLoopNormPrev = normalizeSpinLoop((previous as any)?.spin_loop ?? null);
    const spinStepNormPrev = normalizeSpinStep((previous as any)?.spin_step ?? null);
    const descentGateNormPrev = normalizeDescentGate((previous as any)?.descent_gate ?? null);

    const finalSpinLoop: SpinLoop | null = spinLoopNormInput ?? spinLoopNormPrev ?? null;
    const finalSpinStep: 0 | 1 | 2 | null = spinStepNormInput ?? spinStepNormPrev ?? null;
    const finalDescentGate: DescentGate | null =
      descentGateNormInput ?? descentGateNormPrev ?? null;

    // =========================================================
    // q_counts（IT cooldown / q_trace）
    // =========================================================
    const prevQCounts = normalizeQCounts((previous as any)?.q_counts);
    const incomingQCounts = qCounts ? normalizeQCounts(qCounts) : null;

    // ✅ 方針：cooldown は常に 0（自動ITの停止ロジックに使わない）
    const nextCooldown = 0;

    const nextQCounts: QCounts = {
      ...(incomingQCounts ?? prevQCounts),
      it_cooldown: nextCooldown,
      ...(qTraceForCounts ? { q_trace: qTraceForCounts } : {}),
      ...(itTriggeredResolved != null ? { it_triggered: itTriggeredResolved } : {}),
      ...(itTriggeredForCounts ? { it_triggered_true: true } : {}),
    };

    // =========================================================
    // Anchor candidate（ITの核を拾う）
    // =========================================================
    const itCoreRaw =
      core?.tVector?.core ??
      core?.itResult?.tVector?.core ??
      extra?.tVector?.core ??
      extra?.itResult?.tVector?.core ??
      unified?.tVector?.core ??
      null;

    const itCoreText = typeof itCoreRaw === 'string' ? itCoreRaw.trim() : null;

    const anchorEventTypeResolved: AnchorEventType =
      (anchorFinal as any) ?? pickAnchorEventType(core);

    const anchorCandidate =
      itCoreText ??
      extractAnchorText(core?.intentAnchor) ??
      extractAnchorText(core?.intent_anchor) ??
      null;

    const anchorWrite = shouldWriteIntentAnchorToMemoryState({
      anchorEventType: anchorEventTypeResolved,
      anchorText: anchorCandidate,
    });

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      userText: String(userText ?? '').slice(0, 80),
      depthInput,
      qCodeInput,
      phaseRawInput,
      phaseInput,
      yLevelRaw: core?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: core?.hLevel ?? unified?.hLevel ?? null,
      yLevelInt: yIntInput,
      hLevelInt: hIntInput,
      spinLoopRawInput,
      finalSpinLoop,
      spinStepRawInput,
      finalSpinStep,
      descentGateRawInput,
      finalDescentGate,
      itTriggered: itTriggeredResolved ?? null,
      q_counts_prev: prevQCounts,
      q_counts_next: nextQCounts,
      itx_step: stepFinal,
      itx_anchor_event_type: anchorFinal,
      itx_reason: reasonFinal,
      itx_last_at: lastAtFinal,
      anchor_event: anchorEventTypeResolved,
      anchor_write: anchorWrite.action,
    });

    // =========================================================
    // upsertPayload：null は “保存しない”（過去の値を壊さない）
    // =========================================================
    const upsertPayload: any = {
      user_code: userCode,
      updated_at: nowIso(),
    };

    // =========================================================
    // ✅ intent_layer（core / depth / prev の順で確定）
    // =========================================================
    const intentLayerRaw =
      core?.intent_layer ??
      core?.intentLayer ??
      unified?.intent_layer ??
      unified?.intentLayer ??
      null;

    const intentLayerFromDepth =
      typeof depthInput === 'string' && depthInput.length >= 1
        ? (() => {
            const c = depthInput.trim().charAt(0).toUpperCase();
            return c === 'S' || c === 'R' || c === 'C' || c === 'I' || c === 'T' ? c : null;
          })()
        : null;

    const intentLayerPrev = (previous as any)?.intent_layer ?? (previous as any)?.intentLayer ?? null;

    const intentLayerFinal =
      typeof intentLayerRaw === 'string' &&
      ['S', 'R', 'C', 'I', 'T'].includes(intentLayerRaw.trim().toUpperCase())
        ? (intentLayerRaw.trim().toUpperCase() as any)
        : intentLayerFromDepth ?? intentLayerPrev ?? null;

    if (intentLayerFinal) upsertPayload.intent_layer = intentLayerFinal;

    // =========================================================
    // 基本列
    // =========================================================
    if (depthInput) upsertPayload.depth_stage = depthInput;
    if (qCodeInput) upsertPayload.q_primary = qCodeInput;
    if (phaseInput) upsertPayload.phase = phaseInput;

    if (typeof selfAcceptanceInput === 'number') upsertPayload.self_acceptance = selfAcceptanceInput;
    if (typeof yIntInput === 'number') upsertPayload.y_level = yIntInput;
    if (typeof hIntInput === 'number') upsertPayload.h_level = hIntInput;

    if (sentimentLevelInput != null) upsertPayload.sentiment_level = sentimentLevelInput;
    if (situationSummaryInput) upsertPayload.situation_summary = situationSummaryInput;
    if (situationTopicInput) upsertPayload.situation_topic = situationTopicInput;

    // ✅ 文章メモリ（summary）：ある時だけ更新（過去を壊さない）
    const rawUserText =
      core?.userText ?? core?.user_text ?? core?.input_text ?? core?.text ?? null;

    const summaryCandidate =
      (typeof situationSummaryInput === 'string' && situationSummaryInput.trim()) ||
      (typeof rawUserText === 'string' && rawUserText.trim()) ||
      null;

    if (summaryCandidate) {
      const s = summaryCandidate.replace(/\s+/g, ' ').trim();
      upsertPayload.summary = s.length > 200 ? s.slice(0, 200) : s;
    }

    // ✅ 回転3点：final* を入れる（inputがnullでも previous を保持した final になる）
    if (finalSpinLoop) upsertPayload.spin_loop = finalSpinLoop;
    if (typeof finalSpinStep === 'number') upsertPayload.spin_step = finalSpinStep;

    // descent_gate は列がない環境があるので、入れて失敗なら外して再試行
    if (finalDescentGate) upsertPayload.descent_gate = finalDescentGate;

    // ✅ q_counts
    upsertPayload.q_counts = nextQCounts;

    // =========================================================
    // ✅ ITX列：itx_* に保存（DB列が無い環境を許容）
    // =========================================================
    if (stepFinal) upsertPayload.itx_step = stepFinal;
    if (anchorFinal) upsertPayload.itx_anchor_event_type = anchorFinal;
    if (reasonFinal) upsertPayload.itx_reason = reasonFinal;
    if (lastAtFinal) upsertPayload.itx_last_at = lastAtFinal;

    // =========================================================
    // ✅ intent_anchor 更新（北極星のルール）
    // =========================================================
    if (anchorWrite.action === 'set') {
      upsertPayload.intent_anchor = {
        text: normalizeAnchorText(anchorCandidate ?? ''),
        at: nowIso(),
        type: 'SUN',
      };
    } else if (anchorWrite.action === 'reset') {
      upsertPayload.intent_anchor = null;
    }

    // =========================================================
    // upsert（列欠損を許容して 1回だけ再試行）
    // =========================================================
    let { error } = await supabase.from('iros_memory_state').upsert(upsertPayload, {
      onConflict: 'user_code',
    });

    if (error) {
      const code = (error as any)?.code;
      const msg = String((error as any)?.message ?? '');

      const missing = (name: string) => code === '42703' && new RegExp(name, 'i').test(msg);

      let retried = false;

      if (missing('descent_gate') && 'descent_gate' in upsertPayload) {
        console.warn('[IROS/STATE] descent_gate missing in DB. retry without it.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.descent_gate;
        retried = true;
      }

      // itx_ 系はまとめて落とす（列の有無が環境差）
      if (
        (missing('itx_') || missing('itx_step') || missing('itx_anchor') || missing('itx_reason')) &&
        ('itx_step' in upsertPayload ||
          'itx_anchor_event_type' in upsertPayload ||
          'itx_reason' in upsertPayload ||
          'itx_last_at' in upsertPayload)
      ) {
        console.warn('[IROS/STATE] itx_* missing in DB. drop ITX cols and retry.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.itx_step;
        delete upsertPayload.itx_anchor_event_type;
        delete upsertPayload.itx_reason;
        delete upsertPayload.itx_last_at;
        retried = true;
      }

      if (retried) {
        const retry = await supabase.from('iros_memory_state').upsert(upsertPayload, {
          onConflict: 'user_code',
        });
        error = retry.error ?? null;
      }
    }

    if (error) {
      console.error('[IROS/STATE] persistMemoryStateIfAny failed', { userCode, error });
    } else {
      console.log('[IROS/STATE] persistMemoryStateIfAny ok', {
        userCode,
        saved: Object.keys(upsertPayload),
        depthStage: upsertPayload.depth_stage ?? '(kept)',
        qPrimary: upsertPayload.q_primary ?? '(kept)',
        spinLoop: upsertPayload.spin_loop ?? '(kept)',
        spinStep: upsertPayload.spin_step ?? '(kept)',
        descentGate: upsertPayload.descent_gate ?? '(kept)',
        qCounts: upsertPayload.q_counts ?? '(kept)',
        itx_step: upsertPayload.itx_step ?? '(kept/none)',
        intent_layer: upsertPayload.intent_layer ?? '(kept/none)',
        anchor_action: anchorWrite.action,
      });
    }
  } catch (e) {
    console.error('[IROS/STATE] persistMemoryStateIfAny exception', { userCode, error: e });
  }
}

/* =========================
 * Persist: unified analysis (reserved)
 * ========================= */

export async function persistUnifiedAnalysisIfAny(_args: {
  supabase: SupabaseClient;
  userCode: string;
  tenantId: string;
  userText: string;
  assistantText: string;
  metaForSave: any;
  conversationId: string;
}) {
  // TODO: buildUnifiedAnalysis / saveUnifiedAnalysisInline / applyAnalysisToLastUserMessage を移植する
}
