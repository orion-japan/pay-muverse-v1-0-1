// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (single-writer + memory_state)

import type { SupabaseClient } from '@supabase/supabase-js';

/* =========================
 * Types
 * ========================= */

type Phase = 'Inner' | 'Outer';
type SpinLoop = 'SRI' | 'TCF';
type DescentGate = 'closed' | 'offered' | 'accepted';
type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

// ✅ q_counts は「it_cooldown」等の付帯情報を含み得る（jsonb）
type QCounts = {
  it_cooldown?: number; // 0/1 を想定
  q_trace?: any; // 観測用（DB列追加なしで調査できる）
  [k: string]: any;
};

/* =========================
 * Helpers (minimal / noUnusedLocals-safe)
 * ========================= */

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

  // ✅ 0/1 固定（将来拡張OK）
  return { ...(obj ?? {}), it_cooldown: cd > 0 ? 1 : 0 };
}

/** intent_anchor から text を安全に取り出す */
function extractAnchorText(anchor: any): string | null {
  if (!anchor) return null;
  if (typeof anchor === 'string') return anchor.trim() || null;
  if (typeof anchor === 'object') {
    const t = anchor.text;
    if (typeof t === 'string') return t.trim() || null;
  }
  return null;
}

function normalizeAnchorText(text: string): string {
  return (text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
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
 * “メタ発話・会話制御” はアンカーにしない（固定ルール）
 * ※意味解釈ではなく、危険パターンを明示的に落とす
 */
function isMetaAnchorText(text: string): boolean {
  const s = normalizeAnchorText(text);
  if (!s) return true;

  // 典型メタ
  if (/^覚えて(る|ます)?[？?]?$/.test(s)) return true;
  if (/^何の話(し)?[？?]?$/.test(s)) return true;
  if (/^さっき(話した|言った)(でしょ|よね)?/.test(s)) return true;

  // 極端に短いものは北極星にならない
  if (s.length <= 6) return true;

  // テンプレ批評・AI批評系はアンカーにしない
  const metaKeywords = [
    'AI',
    'iros',
    'Iros',
    'GPT',
    'テンプレ',
    '同じ',
    '繰り返し',
    '一般',
    '違う',
    'それ違う',
    'その答え',
    '足踏み',
  ];
  for (const k of metaKeywords) {
    if (s.includes(k)) return true;
  }

  return false;
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

  if (anchorEventType === 'reset') {
    return { action: 'reset' };
  }

  if (anchorEventType !== 'set') {
    return { action: 'keep' };
  }

  if (!anchorText) return { action: 'keep' };
  if (isMetaAnchorText(anchorText)) return { action: 'keep' };

  return { action: 'set' };
}

/* =========================
 * Persist: messages
 * ========================= */
// ✅ single-writer 固定：assistant は絶対に保存しない（/messages は user-only）
export async function persistAssistantMessage(args: {
  supabase: SupabaseClient; // 使わないが、呼び出し側の統一のため受け取る
  reqOrigin: string;
  authorizationHeader: string | null;
  conversationId: string;
  userCode: string;
  assistantText: string;
  metaForSave: any;

  // ✅ renderEngine 後本文も受け取れるように（あってもなくてもOK）
  content?: string;
  renderedContent?: string;
}) {
  const { conversationId, userCode, metaForSave } = args;

  console.log('[IROS/persistAssistantMessage] HARD-SKIP (single-writer user-only)', {
    conversationId,
    userCode,
  });

  // 呼び出し側が判定できるように “印” だけ残す（任意）
  if (metaForSave && typeof metaForSave === 'object') {
    metaForSave.extra = metaForSave.extra ?? {};
    metaForSave.extra.persistAssistantMessage = false;
    // ※ persistedByRoute は本来 route.ts が付与する印だが、
    //   「二重保存を構造的に根絶」する目的でここでも true にしておく（安全側）
    metaForSave.extra.persistedByRoute = true;
  }

  return {
    ok: true,
    skipped: true,
    reason: 'SINGLE_WRITER_USER_ONLY__ASSISTANT_NEVER_PERSIST',
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
    const m: any = metaForSave ?? null;

    // metaForSave の形が複数あり得るので “実体” を探す
    const core: any = m?.meta ?? m?.finalMeta ?? m;
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
      core?.depth ?? core?.depth_stage ?? core?.depthStage ?? unified?.depth?.stage ?? null;

    // ここは将来 meta から取れるなら差し替え可
    const layer: any = 'inner';
    const polarity: any = 'now';

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
        created_at: new Date().toISOString(),
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

    // unified を最優先で使う（postProcessReply 後は必ず揃っている）
    const unified: any = metaForSave?.unified ?? {};

    // =========================================================
    // ITX（Intent Transition）: metaForSave から確定値を拾う（トップ優先）
    // =========================================================
    const stepRaw =
      (metaForSave as any)?.itx_step ??
      (metaForSave as any)?.itxStep ??
      (metaForSave as any)?.itx?.step ??
      (metaForSave as any)?.extra?.itx_step ??
      (metaForSave as any)?.extra?.itxStep ??
      (metaForSave as any)?.extra?.itx?.step ??
      (unified as any)?.itx_step ??
      (unified as any)?.itxStep ??
      (unified as any)?.itx?.step ??
      null;

    const anchorRaw =
      (metaForSave as any)?.itx_anchor_event_type ??
      (metaForSave as any)?.itxAnchorEventType ??
      (metaForSave as any)?.itx?.anchorEventType ??
      (metaForSave as any)?.anchorEventType ??
      (metaForSave as any)?.extra?.itx_anchor_event_type ??
      (metaForSave as any)?.extra?.itxAnchorEventType ??
      (metaForSave as any)?.extra?.itx?.anchorEventType ??
      (metaForSave as any)?.extra?.anchorEventType ??
      (unified as any)?.itx_anchor_event_type ??
      (unified as any)?.itxAnchorEventType ??
      (unified as any)?.itx?.anchorEventType ??
      (unified as any)?.anchorEventType ??
      null;

    const reasonRaw =
      (metaForSave as any)?.itx_reason ??
      (metaForSave as any)?.itxReason ??
      (metaForSave as any)?.itx?.reason ??
      (metaForSave as any)?.itReason ??
      (metaForSave as any)?.extra?.itx_reason ??
      (metaForSave as any)?.extra?.itxReason ??
      (metaForSave as any)?.extra?.itx?.reason ??
      (metaForSave as any)?.extra?.itReason ??
      (unified as any)?.itx_reason ??
      (unified as any)?.itxReason ??
      (unified as any)?.itx?.reason ??
      null;

    const lastAtRaw =
      (metaForSave as any)?.itx_last_at ??
      (metaForSave as any)?.itxLastAt ??
      (metaForSave as any)?.itx?.lastAt ??
      (metaForSave as any)?.extra?.itx_last_at ??
      (metaForSave as any)?.extra?.itxLastAt ??
      (metaForSave as any)?.extra?.itx?.lastAt ??
      (unified as any)?.itx_last_at ??
      (unified as any)?.itxLastAt ??
      (unified as any)?.itx?.lastAt ??
      null;

    // 正規化（T1/T2/T3 だけを受け付ける）
    const tHint =
      typeof stepRaw === 'string'
        ? stepRaw.trim().toUpperCase()
        : typeof stepRaw === 'number'
          ? String(stepRaw).trim().toUpperCase()
          : '';

    const stepFinal: 'T1' | 'T2' | 'T3' | null =
      tHint === 'T1' || tHint === 'T2' || tHint === 'T3' ? (tHint as any) : null;

    // 正規化（none/confirm/set/reset だけ）
    const a = typeof anchorRaw === 'string' ? anchorRaw.trim().toLowerCase() : '';
    const anchorFinal: 'none' | 'confirm' | 'set' | 'reset' | null =
      a === 'none' || a === 'confirm' || a === 'set' || a === 'reset' ? (a as any) : null;

    // 正規化（空文字は null）
    const reasonFinal =
      typeof reasonRaw === 'string' && reasonRaw.trim().length > 0 ? reasonRaw.trim() : null;

    // 正規化（ISOを期待。とりあえず空でなければ通す）
    const lastAtFinal =
      typeof lastAtRaw === 'string' && lastAtRaw.trim().length > 0 ? lastAtRaw.trim() : null;

    // =========================================================
    // previous を先に取得（merge の土台）
    // ※ ITX列は「未定義列で落ちるDBがある」ので select には入れない（安全）
    // =========================================================
    const { data: previous, error: prevErr } = await supabase
      .from('iros_memory_state')
      .select(
        [
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
          'descent_gate',
          'intent_anchor',
          'summary',
          'situation_summary',
          'situation_topic',
          'sentiment_level',
        ].join(','),
      )
      .eq('user_code', userCode)
      .maybeSingle();

    if (prevErr) {
      console.warn('[IROS/STATE] load previous memory_state not ok (continue)', {
        userCode,
        code: (prevErr as any)?.code,
        message: (prevErr as any)?.message,
      });
    }

    // =========================================================
    // q / depth の入力（取りこぼし防止）
    // =========================================================
    const qCodeInput =
      unified?.q?.current ??
      (metaForSave as any)?.qPrimary ??
      (metaForSave as any)?.q_code ??
      (metaForSave as any)?.qCode ??
      null;

    const depthInput =
      unified?.depth?.stage ??
      (metaForSave as any)?.depth ??
      (metaForSave as any)?.depth_stage ??
      (metaForSave as any)?.depthStage ??
      null;

    // --- IT発火の復元（renderMode=IT から推定しない）---
    const itTriggeredResolved: boolean | null =
      typeof itTriggered === 'boolean'
        ? itTriggered
        : typeof (metaForSave as any)?.itTriggered === 'boolean'
          ? (metaForSave as any).itTriggered
          : typeof (metaForSave as any)?.extra?.itTriggered === 'boolean'
            ? (metaForSave as any).extra.itTriggered
            : null;

    const itTriggeredForCounts = itTriggeredResolved === true;

    // =========================================================
    // QTrace（persistでは“再計算しない” / ただし1固定事故だけ防ぐ）
    // =========================================================
    const prevQ = (previous as any)?.q_primary ?? null;

    const qtu = (metaForSave as any)?.qTraceUpdated;
    const qtuLen =
      typeof qtu?.streakLength === 'number' && Number.isFinite(qtu.streakLength)
        ? Math.max(0, Math.floor(qtu.streakLength))
        : null;

    const qt = (metaForSave as any)?.qTrace;
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
      ? {
          prevQ,
          qNow: qCodeInput,
          streakQ,
          streakLength,
          from: streakFrom,
        }
      : null;

    console.log('[IROS/QTrace] persisted', {
      prevQ,
      qNow: qCodeInput,
      streakQ,
      streakLength,
      from: streakFrom,
    });

    // =========================================================
    // 基本入力
    // =========================================================
    const phaseRawInput = (metaForSave as any)?.phase ?? unified?.phase ?? null;
    const phaseInput = normalizePhase(phaseRawInput);

    const selfAcceptanceInput =
      (metaForSave as any)?.selfAcceptance ??
      unified?.selfAcceptance ??
      unified?.self_acceptance ??
      null;

    const yIntInput = toInt0to3((metaForSave as any)?.yLevel ?? unified?.yLevel);
    const hIntInput = toInt0to3((metaForSave as any)?.hLevel ?? unified?.hLevel);

    const situationSummaryInput =
      (metaForSave as any)?.situationSummary ??
      unified?.situation?.summary ??
      (metaForSave as any)?.situation_summary ??
      null;

    const situationTopicInput =
      (metaForSave as any)?.situationTopic ??
      unified?.situation?.topic ??
      (metaForSave as any)?.situation_topic ??
      null;

    const sentimentLevelInput =
      (metaForSave as any)?.sentimentLevel ??
      (metaForSave as any)?.sentiment_level ??
      unified?.sentiment_level ??
      null;

    // =========================================================
    // spin / descentGate は「normalize → merge」する（nullで潰さない）
    // =========================================================
    const spinLoopRawInput =
      (metaForSave as any)?.spinLoop ??
      (metaForSave as any)?.spin_loop ??
      unified?.spin_loop ??
      unified?.spinLoop ??
      null;

    const spinStepRawInput =
      (metaForSave as any)?.spinStep ??
      (metaForSave as any)?.spin_step ??
      unified?.spin_step ??
      unified?.spinStep ??
      null;

    const descentGateRawInput =
      (metaForSave as any)?.descentGate ??
      (metaForSave as any)?.descent_gate ??
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
    const finalDescentGate: DescentGate | null = descentGateNormInput ?? descentGateNormPrev ?? null;

    // =========================================================
    // q_counts（IT cooldown / q_trace を一本化）
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
      (metaForSave as any)?.tVector?.core ??
      (metaForSave as any)?.itResult?.tVector?.core ??
      (metaForSave as any)?.extra?.tVector?.core ??
      (metaForSave as any)?.extra?.itResult?.tVector?.core ??
      (unified as any)?.tVector?.core ??
      null;

    const itCoreText = typeof itCoreRaw === 'string' ? itCoreRaw.trim() : null;

    const anchorEventTypeResolved: AnchorEventType =
      (anchorFinal as any) ?? pickAnchorEventType(metaForSave);

    const anchorCandidate =
      itCoreText ??
      extractAnchorText((metaForSave as any)?.intentAnchor) ??
      extractAnchorText((metaForSave as any)?.intent_anchor) ??
      null;

    const anchorWrite = shouldWriteIntentAnchorToMemoryState({
      anchorEventType: anchorEventTypeResolved,
      anchorText: anchorCandidate,
    });

    console.log('[IROS/STATE] persistMemoryStateIfAny start', {
      userCode,
      userText: (userText ?? '').slice(0, 80),

      depthInput,
      qCodeInput,
      phaseRawInput,
      phaseInput,

      yLevelRaw: (metaForSave as any)?.yLevel ?? unified?.yLevel ?? null,
      hLevelRaw: (metaForSave as any)?.hLevel ?? unified?.hLevel ?? null,
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

      // ITX
      itx_step: stepFinal,
      itx_anchor_event_type: anchorFinal,
      itx_reason: reasonFinal,
      itx_last_at: lastAtFinal,

      // Anchor gate
      anchor_event: anchorEventTypeResolved,
      anchor_write: anchorWrite.action,
    });

    // 保存する意味がある最低条件
    if (!depthInput && !qCodeInput) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', { userCode });
      return;
    }

    // =========================================================
    // upsertPayload：null は “保存しない”（過去の値を壊さない）
    // =========================================================
    const upsertPayload: any = {
      user_code: userCode,
      updated_at: new Date().toISOString(),
    };

    // =========================================================
    // ✅ intent_layer を必ず決めて保存する（宣言後に代入：ts2448対策）
    // =========================================================
    const intentLayerRaw =
      (metaForSave as any)?.intent_layer ??
      (metaForSave as any)?.intentLayer ??
      (unified as any)?.intent_layer ??
      (unified as any)?.intentLayer ??
      null;

    const intentLayerFromDepth =
      typeof depthInput === 'string' && depthInput.length >= 1
        ? (() => {
            const c = depthInput.trim().charAt(0).toUpperCase();
            return c === 'S' || c === 'R' || c === 'C' || c === 'I' || c === 'T' ? c : null;
          })()
        : null;

    const intentLayerPrev =
      (previous as any)?.intent_layer ?? (previous as any)?.intentLayer ?? null;

    const intentLayerFinal =
      typeof intentLayerRaw === 'string' &&
      ['S', 'R', 'C', 'I', 'T'].includes(intentLayerRaw.trim().toUpperCase())
        ? (intentLayerRaw.trim().toUpperCase() as any)
        : (intentLayerFromDepth ?? intentLayerPrev ?? null);

    if (intentLayerFinal) upsertPayload.intent_layer = intentLayerFinal;

    // =========================================================
    // 基本列
    // =========================================================
    if (depthInput) upsertPayload.depth_stage = depthInput;
    if (qCodeInput) upsertPayload.q_primary = qCodeInput;
    if (phaseInput) upsertPayload.phase = phaseInput;

    if (typeof selfAcceptanceInput === 'number') {
      upsertPayload.self_acceptance = selfAcceptanceInput;
    }

    if (typeof yIntInput === 'number') upsertPayload.y_level = yIntInput;
    if (typeof hIntInput === 'number') upsertPayload.h_level = hIntInput;

    if (sentimentLevelInput != null) upsertPayload.sentiment_level = sentimentLevelInput;
    if (situationSummaryInput) upsertPayload.situation_summary = situationSummaryInput;
    if (situationTopicInput) upsertPayload.situation_topic = situationTopicInput;

    // ✅ 文章メモリ（summary）：ある時だけ更新（過去を壊さない）
    const rawUserText =
      (metaForSave as any)?.userText ??
      (metaForSave as any)?.user_text ??
      (metaForSave as any)?.input_text ??
      (metaForSave as any)?.text ??
      null;

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

    // descent_gate は列がない環境があるので、まず入れて失敗なら外して再試行
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
    // - set のときだけ上書き
    // - reset は null（消す）
    // - keep/confirm は触らない
    // =========================================================
    if (anchorWrite.action === 'set') {
      upsertPayload.intent_anchor = {
        text: normalizeAnchorText(anchorCandidate ?? ''),
        at: new Date().toISOString(),
        type: 'SUN',
      };
    } else if (anchorWrite.action === 'reset') {
      upsertPayload.intent_anchor = null;
    }

    // 1回目 upsert
    let { error } = await supabase.from('iros_memory_state').upsert(upsertPayload, {
      onConflict: 'user_code',
    });

    // 42703(未定義カラム) のとき、原因列を外して1回だけ再試行（descent_gate / ITX）
    if (error) {
      const code = (error as any)?.code;
      const msg = (error as any)?.message ?? '';

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
