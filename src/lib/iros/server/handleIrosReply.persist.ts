// file: src/lib/iros/server/handleIrosReply.persist.ts
// iros - Persist layer (single-writer + memory_state)

import type { SupabaseClient } from '@supabase/supabase-js';
import { decideT3Upgrade } from '@/lib/iros/phase/phase10_t3Upgrade';
// ✅ アンカー汚染判定は「共通の唯一」を使う（重複定義しない）
import { isMetaAnchorText } from '@/lib/iros/intentAnchor';
import { computeAnchorEntry } from '@/lib/iros/server/computeAnchorEntry';

/* =========================
 * Types
 * ========================= */

type Phase = 'Inner' | 'Outer';
type SpinLoop = 'SRI' | 'TCF';
type DescentGate = 'closed' | 'offered' | 'accepted';

// IT系（既存）
type AnchorEventType = 'none' | 'confirm' | 'set' | 'reset';

// ✅ DB列 anchor_event / anchor_write（FN_SUN 側の entry を記録する）
type AnchorEvent = 'none' | 'confirm' | 'set' | 'reset' | 'action';
type AnchorWrite = 'keep' | 'set' | 'reset' | 'commit';

// ✅ q_counts は付帯情報を含み得る（jsonb）
type QCounts = {
  it_cooldown?: number; // 0/1
  q_trace?: any;
  it_triggered?: boolean;
  it_triggered_true?: boolean; // “そのターンで true だったか”
  [k: string]: any;
};

type PrevMemoryState =
  | {
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

      // ✅ 環境差あり（列が無いことがある）
      anchor_event?: any;
      anchor_write?: any;

      // intent_anchor は jsonb (例: {key:"SUN"} )
      intent_anchor?: any;

      summary?: string | null;
      situation_summary?: string | null;
      situation_topic?: string | null;
      sentiment_level?: any;

      // 環境差あり（列が無いことがある）
      itx_step?: any;
      itx_anchor_event_type?: any;
      itx_reason?: any;
      itx_last_at?: any;
    }
  | null;

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

/**
 * intent_anchor から key を安全に取り出す（文字列汚染・object混入の吸収）
 * - "SUN" も受ける
 * - { key:"SUN" } も受ける
 */
function extractIntentAnchorKey(v: any): string | null {
  if (!v) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === 'object') {
    const k = (v as any).key;
    if (typeof k === 'string') {
      const s = k.trim();
      return s.length ? s : null;
    }
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
 * - reset は「消す」なので key 不要
 * - メタ発話は set でも絶対拒否（textがある場合のみ判定）
 */
function shouldWriteIntentAnchorToMemoryState(args: {
  anchorEventType: AnchorEventType;
  anchorKey: string | null;
  anchorTextMaybe: string | null;
}): { action: 'keep' | 'set' | 'reset' } {
  const { anchorEventType, anchorKey, anchorTextMaybe } = args;

  if (anchorEventType === 'reset') return { action: 'reset' };
  if (anchorEventType !== 'set') return { action: 'keep' };

  // set のときは key が必要
  if (!anchorKey) return { action: 'keep' };

  // text がある場合のみ「メタ発話」を拒否（keyベースでは拒否しない）
  if (anchorTextMaybe && isMetaAnchorText(anchorTextMaybe)) return { action: 'keep' };

  return { action: 'set' };
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
    // ✅ あれば読む
    'anchor_event',
    'anchor_write',
  ];

  const withDescent = [...baseCols, 'descent_gate'];

  const r1 = await supabase
    .from('iros_memory_state')
    .select(withDescent.join(','))
    .eq('user_code', userCode)
    .maybeSingle();

  if (!r1.error) return (r1.data as any) ?? null;

  const code = (r1.error as any)?.code;
  const msg = String((r1.error as any)?.message ?? '');

  // 42703: drop descent_gate and retry
  if (!(code === '42703' && /descent_gate/i.test(msg))) {
    console.warn('[IROS/STATE] load previous memory_state not ok (continue)', {
      userCode,
      code,
      message: msg,
    });
    return null;
  }

  console.warn('[IROS/STATE] previous select missing descent_gate. retry without it.', {
    userCode,
    code,
    message: msg,
  });

  const r2 = await supabase
    .from('iros_memory_state')
    .select(baseCols.join(','))
    .eq('user_code', userCode)
    .maybeSingle();

  if (r2.error) {
    console.warn('[IROS/STATE] load previous memory_state retry not ok (continue)', {
      userCode,
      code: (r2.error as any)?.code,
      message: (r2.error as any)?.message,
    });
    return null;
  }

  return (r2.data as any) ?? null;
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
    const core: any = root?.meta ?? root?.finalMeta ?? root;
    const unified: any = core?.unified ?? null;

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

    const stage: any =
      core?.depth ??
      core?.depth_stage ??
      core?.depthStage ??
      unified?.depth?.stage ??
      null;

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

  // ✅ 任意：anchorEntry decision を外から渡せる（handleIrosReply → persist の橋）
  // - ここが来たら persist 内の再計算より優先
  anchorEntry_decision?: {
    anchorEvent?: AnchorEvent | null;
    anchorWrite?: AnchorWrite | null;
    reason?: string | null;
    [k: string]: any;
  } | null;

  // ✅ 任意：tenantId（Phase10 T3判定で prev を拾うため）
  tenantId?: string;

  // ✅ 任意：Phase10
  t3Evidence?: any;
  evidence?: any;
  phase10Cfg?: any;
  cfg?: any;
}) {
  const {
    supabase,
    userCode,
    userText,
    metaForSave,
    qCounts,
    itTriggered,
    anchorEntry_decision: anchorEntryDecisionOverride,
  } = args;

  try {
    if (!metaForSave) return;

    console.log('[IROS/STATE][anchor-root]', {
      userTextHead: String(userText ?? '').slice(0, 80),
    });

    // =========================================================
    // ✅ FINALで確定した meta を最優先（persistでは再計算しない）
    //   - ここで取れた値は、後続の判定/ログ/保存に必ず使う
    // =========================================================
    const pick = <T = any>(...vals: any[]): T | null => {
      for (const v of vals) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.trim().length === 0) continue;
        return v as T;
      }
      return null;
    };

    // metaの揺れ吸収用（root/core）
    const root: any = metaForSave ?? null;
    const core: any = root?.meta ?? root?.finalMeta ?? root;
    const unified: any = core?.unified ?? {};
    const extra: any = root?.extra ?? core?.extra ?? null;

    // intent_anchor（object/key）
    const metaIntentAnchorObj = pick<any>(
      metaForSave?.intent_anchor,
      metaForSave?.meta?.intent_anchor,
      metaForSave?.final?.intent_anchor,
      metaForSave?.framePlan?.meta?.intent_anchor,
      core?.intent_anchor,
      core?.intentAnchor,
      unified?.intent_anchor,
    );
    const metaIntentAnchorKey = pick<string>(
      metaForSave?.intent_anchor_key,
      metaForSave?.meta?.intent_anchor_key,
      metaForSave?.final?.intent_anchor_key,
      metaForSave?.framePlan?.meta?.intent_anchor_key,
      core?.intent_anchor_key,
      unified?.intent_anchor_key,
      // fallback: object.key
      metaIntentAnchorObj?.key,
      // fallback: fixedNorthKey
      core?.fixedNorthKey,
      core?.fixedNorth?.key,
      unified?.fixedNorthKey,
      unified?.fixedNorth?.key,
    );

    // itx（T層）
    const metaItxStep = pick<string>(
      metaForSave?.itx_step,
      metaForSave?.meta?.itx_step,
      metaForSave?.final?.itx_step,
      metaForSave?.framePlan?.meta?.itx_step,
      core?.itx_step,
      unified?.itx_step,
    );
    const metaItxReason = pick<string>(
      metaForSave?.itx_reason,
      metaForSave?.meta?.itx_reason,
      metaForSave?.final?.itx_reason,
      metaForSave?.framePlan?.meta?.itx_reason,
      core?.itx_reason,
      unified?.itx_reason,
    );
    const metaItxLastAt = pick<string>(
      metaForSave?.itx_last_at,
      metaForSave?.meta?.itx_last_at,
      metaForSave?.final?.itx_last_at,
      metaForSave?.framePlan?.meta?.itx_last_at,
      core?.itx_last_at,
      unified?.itx_last_at,
    );

    const fixedByMeta = {
      intent_anchor_obj:
        metaIntentAnchorObj ?? (metaIntentAnchorKey ? { key: metaIntentAnchorKey } : null),
      intent_anchor_key: metaIntentAnchorKey,
      itx_step: metaItxStep,
      itx_reason: metaItxReason,
      itx_last_at: metaItxLastAt,
    };

    console.log('[IROS/STATE][fixed-by-meta]', fixedByMeta);

    // =========================================================
    // AnchorEntry（persist内の再計算） + ✅ override（handleIrosReply優先）
    // =========================================================
    const anchorEntry = computeAnchorEntry(root);

    // ✅ “最終決定（唯一の参照点）”
    const anchorEntryDecisionFinal: any =
      anchorEntryDecisionOverride ??
      anchorEntry?.decision ??
      core?.anchorEntry?.decision ??
      extra?.anchorEntry?.decision ??
      null;

    // =========================================================
    // previous（環境差に強い読み）
    // =========================================================
    const previous = await safeLoadPreviousMemoryState(supabase, userCode);

    // =========================================================
    // q / depth（取りこぼし防止：core/unified）
    // - qTraceUpdated を最優先で拾う（streak巻き戻り防止の本丸）
    // =========================================================

    const qTraceEffective: any =
      core?.qTraceUpdated ??
      unified?.qTraceUpdated ??
      core?.qTrace ??
      unified?.qTrace ??
      core?.q_counts?.q_trace ??
      unified?.q_counts?.q_trace ??
      null;

      const qCodeInput: any =
      unified?.q?.current ??
      unified?.qCode ??
      core?.qPrimary ??
      core?.q_now ??
      core?.q_code ??
      core?.qCode ??
      // ---- qTrace variations (absorb schema differences) ----
      qTraceEffective?.qNow ??
      qTraceEffective?.q_now ??
      qTraceEffective?.currentQ ??
      qTraceEffective?.snapshot?.currentQ ??
      qTraceEffective?.lastQ ??
      qTraceEffective?.streakQ ??
      qTraceEffective?.dominantQ ??
      null;
    const depthInput: any =
      unified?.depth?.stage ??
      unified?.depthStage ??
      core?.depth ??
      core?.depth_stage ??
      core?.depthStage ??
      null;

    // 保存する意味がある最低条件
    if (!depthInput && !qCodeInput) {
      console.warn('[IROS/STATE] skip persistMemoryStateIfAny (no depth/q)', { userCode });
      return;
    }

    // =========================================================
    // ✅ アンカー関連（set/reset以外はDB更新しない）
    // =========================================================
    // anchorEventTypeResolved は meta(core) を優先しつつ、
    // AnchorEntry decision（commit/action）も set 相当として扱う
    const anchorEventTypeResolved: AnchorEventType = (() => {
      const fromMeta = pickAnchorEventType(core);
      if (fromMeta !== 'none') return fromMeta;

      const aw = anchorEntryDecisionFinal?.anchorWrite ?? null;
      const ae = anchorEntryDecisionFinal?.anchorEvent ?? null;

      // commit/action は「北極星が確定した」扱い → set 相当
      if (aw === 'commit' || ae === 'action') return 'set';
      return 'none';
    })();

    // key（最優先: fixed-by-meta / 既存DB / fixedNorth）
    const anchorKeyCandidate =
      fixedByMeta.intent_anchor_key ??
      extractIntentAnchorKey((previous as any)?.intent_anchor) ??
      extractIntentAnchorKey(core?.fixedNorthKey ?? core?.fixedNorth?.key ?? null) ??
      extractIntentAnchorKey(unified?.fixedNorthKey ?? unified?.fixedNorth?.key ?? null) ??
      null;

    // text（汚染判定用の “任意”）
    const itCoreRaw =
      core?.tVector?.core ??
      core?.itResult?.tVector?.core ??
      extra?.tVector?.core ??
      extra?.itResult?.tVector?.core ??
      unified?.tVector?.core ??
      null;
    const anchorTextMaybe = typeof itCoreRaw === 'string' ? itCoreRaw.trim() : null;

    const anchorWrite = shouldWriteIntentAnchorToMemoryState({
      anchorEventType: anchorEventTypeResolved,
      anchorKey: anchorKeyCandidate,
      anchorTextMaybe,
    });

    // =========================================================
    // 基本入力（core/unified）
    // =========================================================
// =========================================================
// 基本入力（core/unified） + PhaseのEWMA（0.7/0.3）
// - outer_now: 0..1（暫定：phaseInput由来）
// - outer_smoothed を q_counts に保存して「毎回計測」を成立させる
// - phase は outer_smoothed からヒステリシス付きで決める（パカパカ防止）
// =========================================================
const phaseRawInput = core?.phase ?? unified?.phase ?? null;
const phaseInputRaw = normalizePhase(phaseRawInput); // 'Inner' | 'Outer' | null

// now（暫定）：Inner=0 / Outer=1（※将来スコア源が来たらここを差し替える）
const outerNow: number | null =
  phaseInputRaw === 'Outer' ? 1 : phaseInputRaw === 'Inner' ? 0 : null;

// prev（優先）：q_counts.phase_outer_smoothed → 無ければ previous.phase から 0/1
const prevOuterSmoothed: number | null = (() => {
  const prevQc = (previous as any)?.q_counts;
  const v = prevQc?.phase_outer_smoothed;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const clamped = Math.max(0, Math.min(1, v));
    return clamped;
  }

  const prevPhase = normalizePhase((previous as any)?.phase ?? null);
  if (prevPhase === 'Outer') return 1;
  if (prevPhase === 'Inner') return 0;
  return null;
})();

// EWMA（0.7/0.3）
const outerSmoothed: number | null = (() => {
  if (outerNow == null && prevOuterSmoothed == null) return null;
  if (prevOuterSmoothed == null) return outerNow; // 初回
  if (outerNow == null) return prevOuterSmoothed; // 今回観測不能なら維持
  const v = 0.7 * prevOuterSmoothed + 0.3 * outerNow;
  return Math.max(0, Math.min(1, v));
})();

// ヒステリシスで phase を確定（0.55/0.45帯の中は維持）
const phaseInput: Phase | null = (() => {
  const prevPhase = normalizePhase((previous as any)?.phase ?? null);

  if (outerSmoothed == null) {
    // スコアが作れないなら従来通り
    return phaseInputRaw ?? prevPhase ?? null;
  }

  if (outerSmoothed >= 0.55) return 'Outer';
  if (outerSmoothed <= 0.45) return 'Inner';

  // 中間帯は維持
  return prevPhase ?? phaseInputRaw ?? null;
})();


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
    const finalDescentGate: DescentGate | null = descentGateNormInput ?? descentGateNormPrev ?? null;

    // =========================================================
    // ITX（Intent Transition）: “発火 true のときだけ保存”
    // - false は作らず、null = keep とする
    // =========================================================

// ✅ itTriggered は “true のときだけ” 意味を持つ（それ以外は「不明」として扱う）
// - null に落とさない（undefined にして payload/ログから消える）
// - “不明を false に丸めない” を守る
const itTriggeredResolved: true | undefined =
  itTriggered === true ||
  core?.itTriggered === true ||
  extra?.itTriggered === true
    ? true
    : undefined;

    // ✅ 明示クリア（将来用）。存在しなければ絶対にクリアしない。
    const clearItxExplicit: boolean =
      core?.clearItx === true ||
      core?.itxClear === true ||
      extra?.clearItx === true ||
      extra?.itxClear === true ||
      unified?.clearItx === true ||
      unified?.itxClear === true;

    // ✅ クリアは「明示指定のみ」
    const shouldClearItx: boolean = clearItxExplicit;

    // meta側で “T2維持” を固定したい時がある（今回ログのケース）
    const itxStepFromMeta = fixedByMeta.itx_step;
    const itxReasonFromMeta = fixedByMeta.itx_reason;
    const itxLastAtFromMeta = fixedByMeta.itx_last_at;

    type EffectiveItx =
      | {
          itx_step: string | null;
          itx_anchor_event_type: AnchorEventType | null;
          itx_reason: string | null;
          itx_last_at: string | null;
        }
      | null;

    const effectiveItx: EffectiveItx =
      itTriggeredResolved === true
        ? {
            itx_step: itxStepFromMeta ?? null,
            itx_anchor_event_type:
              (anchorEventTypeResolved && anchorEventTypeResolved !== 'none'
                ? anchorEventTypeResolved
                : null) ?? null,
            itx_reason: itxReasonFromMeta ?? 'IT_TRIGGER_OK',
            itx_last_at: (itxLastAtFromMeta ?? nowIso()) as string,
          }
        : shouldClearItx
          ? {
              itx_step: null,
              itx_anchor_event_type: null,
              itx_reason: null,
              itx_last_at: null,
            }
          : null;

    // 👇 ログ（start）：keep/clear が分かるように出す（JSON壊さない）
    console.log(
      '[IROS/STATE] persistMemoryStateIfAny start',
      JSON.stringify(
        {
          userCode,
          userText: String(userText ?? '').slice(0, 80),
          depthInput,
          qCodeInput,
          phaseInput,
          yLevelInt: yIntInput ?? null,
          hLevelInt: hIntInput ?? null,
          finalSpinLoop: finalSpinLoop ?? null,
          finalSpinStep: finalSpinStep ?? null,
          finalDescentGate: finalDescentGate ?? null,

          itTriggered: itTriggeredResolved ?? null,
          clearItxExplicit,
          shouldClearItx,

          itx_step: effectiveItx ? effectiveItx.itx_step : '(keep)',
          itx_anchor_event_type: effectiveItx ? effectiveItx.itx_anchor_event_type : '(keep)',
          itx_reason: effectiveItx ? effectiveItx.itx_reason : '(keep)',
          itx_last_at: effectiveItx ? effectiveItx.itx_last_at : '(keep)',

          anchor_event_db: anchorEntryDecisionFinal?.anchorEvent ?? null,
          anchor_write_db: anchorEntryDecisionFinal?.anchorWrite ?? null,
          anchorEntry_decision: anchorEntryDecisionFinal ?? null,

          intent_anchor_key_candidate: anchorKeyCandidate ?? null,
          anchor_action: anchorWrite.action,

          // ★ 観測：qTraceUpdated を拾えてるか（フィールド差分も見る）
          qTracePickedFrom: qTraceEffective ? 'qTraceEffective' : null,
          qTrace_keys:
            qTraceEffective && typeof qTraceEffective === 'object' ? Object.keys(qTraceEffective).slice(0, 20) : null,

          qTrace_qNow: qTraceEffective?.qNow ?? null,
          qTrace_q_now: (qTraceEffective as any)?.q_now ?? null,
          qTrace_currentQ: (qTraceEffective as any)?.currentQ ?? null,
          qTrace_snapshot_currentQ: (qTraceEffective as any)?.snapshot?.currentQ ?? null,

          qTrace_streakQ: qTraceEffective?.streakQ ?? (qTraceEffective as any)?.streak_q ?? null,
          qTrace_streakLength:
            qTraceEffective?.streakLength ?? (qTraceEffective as any)?.streak_length ?? null,

        },
        null,
        0,
      ),
    );

    // =========================================================
    // ✅ Phase10: T3 upgrade 判定（ここは「判定だけ」）
    // prev は「この関数スコープでDBから取る」
    // =========================================================
    const tenantIdLocal = String((args as any)?.tenantId ?? 'default');

    let prevRow: any = null;

    // 1) tenant 条件つき（まずはこれ）
    try {
      const r1 = await supabase
        .from('iros_memory_state')
        .select('itx_step,itx_last_at,intent_anchor,anchor_write,anchor_event')
        .eq('user_code', userCode)
        .eq('tenant_id', tenantIdLocal)
        .maybeSingle();

      prevRow = (r1 as any)?.data ?? null;
    } catch (_) {
      prevRow = null;
    }

    // 2) fallback：tenant が合わない/列が無い/値がnullの既存データ救済
    if (!prevRow) {
      const r2 = await supabase
        .from('iros_memory_state')
        .select('itx_step,itx_last_at,intent_anchor,anchor_write,anchor_event')
        .eq('user_code', userCode)
        .maybeSingle();

      prevRow = (r2 as any)?.data ?? null;
    }

    const _prevMem: any = prevRow ?? null;

    // ✅ decideT3Upgrade の判定で使う prev を正規化（snake/camel 両対応）
    const prevForT3: PrevMemoryState | null = _prevMem
      ? {
          itx_step: _prevMem.itx_step ?? _prevMem.itxStep ?? null,
          itx_last_at: _prevMem.itx_last_at ?? _prevMem.itxLastAt ?? null,
          intent_anchor: _prevMem.intent_anchor ?? _prevMem.intentAnchor ?? null,
          anchor_write: _prevMem.anchor_write ?? _prevMem.anchorWrite ?? null,
          anchor_event: _prevMem.anchor_event ?? _prevMem.anchorEvent ?? null,
        }
      : null;

    // ✅ intent_anchor は “キー文字列” を優先（object混入を防ぐ）
    const intentAnchorKeyForT3 =
      fixedByMeta.intent_anchor_key ??
      extractIntentAnchorKey(core?.fixedNorthKey ?? core?.fixedNorth?.key ?? null) ??
      extractIntentAnchorKey(core?.intent_anchor ?? core?.intentAnchor ?? null) ??
      extractIntentAnchorKey(unified?.fixedNorthKey ?? unified?.fixedNorth?.key ?? null) ??
      extractIntentAnchorKey(unified?.intent_anchor ?? null) ??
      extractIntentAnchorKey((previous as any)?.intent_anchor ?? null) ??
      null;

    // T3判定用 nowForT3 は decisionFinal を見る（override を確実に反映）
    const nowForT3: any = {
      itx_step: (fixedByMeta.itx_step ?? (effectiveItx ? effectiveItx.itx_step : null)) ?? null,
      itx_last_at:
        (fixedByMeta.itx_last_at ?? (effectiveItx ? effectiveItx.itx_last_at : null)) ?? null,
      intent_anchor: intentAnchorKeyForT3,
      anchor_write: anchorEntryDecisionFinal?.anchorWrite ?? null,
      anchor_event: anchorEntryDecisionFinal?.anchorEvent ?? null,
    };

    // ✅ evidence/cfg（呼び出し側が渡してきたら使う）
    const t3EvidenceLocal = (args as any).t3Evidence ?? (args as any).evidence ?? null;
    const phase10CfgLocal = (args as any).phase10Cfg ?? (args as any).cfg ?? undefined;

    // NOTE: 再発防止（ログ誤読防止）
    // Phase10 enter は phase10_t3Upgrade.ts 側で統一ログを出すため、ここでは二重発火を避ける。
    // console.log('[IROS/PHASE10_T3][enter]', { ... }); // disabled (enter log lives in phase10_t3Upgrade.ts)



    const t3Decision = decideT3Upgrade({
      prev: prevForT3,
      now: nowForT3,
      evidence: t3EvidenceLocal,
      cfg: phase10CfgLocal,
    });

    if (
      typeof process !== 'undefined' &&
      process.env.DEBUG_IROS_IT === '1' &&
      (!process.env.DEBUG_USER ||
        process.env.DEBUG_USER === String(userCode ?? ''))

    ) {
      console.log('[IROS/PHASE10_T3][result]', {
        phase10Upgrade: t3Decision?.upgrade ?? null,
        phase10NextItxStep: (t3Decision as any)?.nextItxStep ?? null,
        phase10Reason: (t3Decision as any)?.reason ?? null,
      });
    }



// ✅ 修正版：T3 upgrade の“発生時だけ” itx_* を書く（keep は触らない）
const itxForSave: EffectiveItx =
  t3Decision.upgrade === true &&
  t3Decision.nextItxStep === 'T3' &&
  anchorEventTypeResolved &&
  anchorEventTypeResolved !== 'none'
    ? {
        itx_step: 'T3',
        itx_anchor_event_type: anchorEventTypeResolved,
        itx_reason: 'T3_UPGRADE',
        itx_last_at: nowIso(),
      }
    : null;


// =========================================================
// ✅ upsert payload（“null は入れない” を徹底：keep を壊さない）
// =========================================================
const upsertPayload: Record<string, any> = {
  user_code: userCode,
  updated_at: nowIso(),
};

if (depthInput != null) upsertPayload.depth_stage = depthInput;

// ============================================================
// Depth trend（S/R/C/I/T）EWMA更新（0.7 / 0.3）→ 正規化 → dominantBand
// 保存先：iros_memory_state.depth_trend（jsonb / UI用）
// ============================================================

if (typeof depthInput === 'string' && depthInput.trim()) {
  // depthInput 例: S1..S3 / R1..R3 / C1..C3 / I1..I3 / T1..T3
  const depthStageNow = depthInput.trim().toUpperCase();

  const bandNow =
    /^[SRCIT][123]$/.test(depthStageNow) ? (depthStageNow[0] as 'S' | 'R' | 'C' | 'I' | 'T') : null;

  // 既存 depth_trend を取得（なければ初期化）
  const prevTrendRaw = (previous as any)?.depth_trend ?? null;
  const prevBandScoresRaw = prevTrendRaw?.band_scores ?? null;

  const keys: Array<'S' | 'R' | 'C' | 'I' | 'T'> = ['S', 'R', 'C', 'I', 'T'];

  // prevBandScores を 0..1 に正規化（過去に 0..100 が入ってた互換も吸収）
  const prevBandScores: Record<'S' | 'R' | 'C' | 'I' | 'T', number> = {
    S: 0,
    R: 0,
    C: 0,
    I: 0,
    T: 0,
  };

  {
    const rawVals = keys.map((k) => {
      const v = (prevBandScoresRaw as any)?.[k];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    });

    const max = Math.max(...rawVals);
    const scale = max > 1.00001 ? 100 : 1; // 0..100っぽければ 100で割る

    for (const k of keys) {
      const v = (prevBandScoresRaw as any)?.[k];
      const n = typeof v === 'number' && Number.isFinite(v) ? v / scale : 0;
      prevBandScores[k] = Math.max(0, Math.min(1, n));
    }

    const sumPrev = Object.values(prevBandScores).reduce((a, b) => a + b, 0);
    if (sumPrev > 0) {
      for (const k of keys) prevBandScores[k] = prevBandScores[k] / sumPrev;
    }
  }

  // EWMA更新（bandNow が取れない時は “前回を保持”）
  const newBandScores: Record<'S' | 'R' | 'C' | 'I' | 'T', number> = {
    S: 0,
    R: 0,
    C: 0,
    I: 0,
    T: 0,
  };

  for (const k of keys) {
    const prev = prevBandScores[k] ?? 0;
    const base = 0.7 * prev;
    const add = bandNow === k ? 0.3 : 0;
    newBandScores[k] = base + add;
  }

  // 正規化（合計1）
  const sum = Object.values(newBandScores).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const k of keys) newBandScores[k] = newBandScores[k] / sum;
  }

  // dominantBand 決定
  let dominantBand: 'S' | 'R' | 'C' | 'I' | 'T' | null = null;
  let maxScore = -1;
  for (const k of keys) {
    const v = typeof newBandScores[k] === 'number' ? newBandScores[k] : 0;
    if (v > maxScore) {
      maxScore = v;
      dominantBand = k;
    }
  }

  // depth_trend に保存（jsonb）
  upsertPayload.depth_trend = {
    ...(prevTrendRaw && typeof prevTrendRaw === 'object' ? prevTrendRaw : {}),
    band_scores: newBandScores,
    dominant_band: dominantBand,
    depth_stage_now: depthStageNow,
    band_now: bandNow,
    ewma: { prev: 0.7, now: 0.3 },
    updated_at: nowIso(),
  };
}
// ============================================================
// ✅ V3: Qコード EWMA更新（0.7 / 0.3）→ 正規化 → dominantQ決定
// - 入力は「e_turn（観測）」を最優先にする
// - e_turn が取れないターンだけ qCodeInput（meta由来Q）へフォールバック
// 保存先：q_counts.q_scores（UI用）
// ============================================================

// ---- 1) e_turn（観測）を拾う：meta.extra（=正本）→ 互換キー ----
const eTurnRaw: any =
  extra?.e_turn ??
  extra?.mirror?.e_turn ??
  core?.e_turn ??
  core?.mirror?.e_turn ??
  unified?.e_turn ??
  unified?.mirror?.e_turn ??
  null;

const eTurnNow: string | null =
  typeof eTurnRaw === 'string' && /^(e1|e2|e3|e4|e5)$/i.test(eTurnRaw.trim())
    ? eTurnRaw.trim().toLowerCase()
    : null;

// ---- 2) e_turn → Q への写像（V3本命）----
const qNowFromETurn: string | null =
  eTurnNow === 'e1'
    ? 'Q1'
    : eTurnNow === 'e2'
      ? 'Q2'
      : eTurnNow === 'e3'
        ? 'Q3'
        : eTurnNow === 'e4'
          ? 'Q4'
          : eTurnNow === 'e5'
            ? 'Q5'
            : null;

// ---- 3) 互換：meta由来Q（暫定フォールバック）----
const qNowRaw = qCodeInput ?? null;
const qNowFromMeta: string | null =
  typeof qNowRaw === 'string' && /^(Q1|Q2|Q3|Q4|Q5)$/i.test(qNowRaw.trim())
    ? qNowRaw.trim().toUpperCase()
    : null;

// ✅ EWMAの “now” は e_turn を最優先
const qNow: string | null = qNowFromETurn ?? qNowFromMeta ?? null;

// 既存q_counts取得（なければ初期化）
const prevQc = (previous as any)?.q_counts ?? {};
const prevScoresRaw = prevQc?.q_scores ?? {
  Q1: 0,
  Q2: 0,
  Q3: 0,
  Q4: 0,
  Q5: 0,
};

// prevScores を 0..1 に正規化（過去に 0..100 が入ってた互換も吸収）
const prevScores: Record<string, number> = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0 };
{
  const keys = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
  const rawVals = keys.map((k) => {
    const v = (prevScoresRaw as any)?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
  const sumRaw = rawVals.reduce((a, b) => a + b, 0);
  const scale = sumRaw > 1.00001 ? 100 : 1;
  for (const k of keys) {
    const v = typeof (prevScoresRaw as any)?.[k] === 'number' ? (prevScoresRaw as any)[k] : 0;
    prevScores[k] = Math.max(0, Math.min(1, v / scale));
  }
  const sumPrev = Object.values(prevScores).reduce((a, b) => a + b, 0);
  if (sumPrev > 0) {
    for (const k of keys) prevScores[k] = prevScores[k] / sumPrev;
  }
}

const newScores: Record<string, number> = { Q1: 0, Q2: 0, Q3: 0, Q4: 0, Q5: 0 };

// EWMA更新（qNow が無い時は “前回を保持”）
for (const q of Object.keys(newScores)) {
  const prev = typeof prevScores[q] === 'number' ? prevScores[q] : 0;
  const base = 0.7 * prev;
  const add = qNow === q ? 0.3 : 0;
  newScores[q] = base + add;
}

// 正規化（合計1）
const sum = Object.values(newScores).reduce((a, b) => a + b, 0);
if (sum > 0) {
  for (const q of Object.keys(newScores)) newScores[q] = newScores[q] / sum;
}

// dominantQ決定
let dominantQ: string | null = null;
let maxScore = -1;
for (const q of Object.keys(newScores)) {
  const v = typeof newScores[q] === 'number' ? newScores[q] : 0;
  if (v > maxScore) {
    maxScore = v;
    dominantQ = q;
  }
}

// q_counts に保存（UI用）
const qcBase = normalizeQCounts(qCounts ?? prevQc ?? null);
(qcBase as any).q_scores = newScores;
(qcBase as any).q_updated_at = nowIso();

// ✅ 観測の内訳（デバッグ用）
(qcBase as any).q_now_src = qNowFromETurn ? 'e_turn' : qNowFromMeta ? 'meta_q' : 'none';
(qcBase as any).e_turn_now = eTurnNow ?? null;

upsertPayload.q_counts = qcBase;

// ✅ 主Q更新は “e_turn 観測が取れた時だけ” に限定（meta由来Qで勝手に更新しない）
// - qNowFromETurn は string|null なので boolean を明示しておく
if (dominantQ && qNowFromETurn != null) {
  upsertPayload.q_primary = dominantQ;
}

if (phaseInput != null) upsertPayload.phase = phaseInput;

if (typeof selfAcceptanceInput === 'number' && Number.isFinite(selfAcceptanceInput)) {
  upsertPayload.self_acceptance = selfAcceptanceInput;
}

if (typeof yIntInput === 'number') upsertPayload.y_level = yIntInput;
if (typeof hIntInput === 'number') upsertPayload.h_level = hIntInput;

if (finalSpinLoop != null) upsertPayload.spin_loop = finalSpinLoop;
if (finalSpinStep != null) upsertPayload.spin_step = finalSpinStep;
if (finalDescentGate != null) upsertPayload.descent_gate = finalDescentGate;

if (situationSummaryInput != null) upsertPayload.situation_summary = situationSummaryInput;
if (situationTopicInput != null) upsertPayload.situation_topic = situationTopicInput;
if (sentimentLevelInput != null) upsertPayload.sentiment_level = sentimentLevelInput;

// =========================================================
// ✅ q_counts（外部優先 → core優先 → previousは“触らない”）
// - 追加：qTraceEffective を qc.q_trace に合流（streakの巻き戻り防止）
// - 修正：q_counts が null でも「書く根拠」があれば初期化して保存する
//   （itTriggered / fa_pending / fa_lock が来たターンは必ず upsert）
// =========================================================
const qCountsPicked = qCounts ?? core?.q_counts ?? null;

  // ------------------------------------------------------------
  // ✅ it_triggered / it_triggered_true は “undefined を false に丸めない”
  // ------------------------------------------------------------
  if (qCountsPicked != null) {
    const qc = normalizeQCounts(qCountsPicked);

    // ✅ it_triggered / it_triggered_true は “undefined を false に丸めない”
    const itTriggeredResolvedBool: boolean | undefined =
      typeof itTriggered === 'boolean'
        ? itTriggered
        : typeof (core as any)?.itTriggered === 'boolean'
          ? (core as any).itTriggered
          : typeof (metaForSave as any)?.itTriggered === 'boolean'
            ? (metaForSave as any).itTriggered
            : undefined;

    qc.it_triggered_true = itTriggeredResolvedBool === true;
    if (typeof itTriggeredResolvedBool === 'boolean') qc.it_triggered = itTriggeredResolvedBool;


  } else if (typeof itTriggeredResolved === 'boolean') {

  const qc = normalizeQCounts({ it_cooldown: 0 });
  qc.it_triggered_true = itTriggered === true;
  qc.it_triggered = itTriggered;
  upsertPayload.q_counts = qc;

  console.log('[IROS/PERSIST][q_counts][synth]', {
    reason: 'qCountsPicked_null_but_itTriggered_present',
    it_triggered: itTriggered,
    it_triggered_true: qc.it_triggered_true,
  });
}

// ============================================================
// 暫定深度 EWMA（S/R/C/I/T）更新（0.7 / 0.3）→ 正規化 → dominant決定
// 保存先：q_counts.depth_scores（UI用） + q_counts.depth_dominant
// ============================================================

// depthNow を安全に正規化（S/R/C/I/T 以外は無視）
const depthNowRaw = depthInput ?? null;

// 例: "R3" -> "R"
const depthNow =
  typeof depthNowRaw === 'string' && /^[SRCIT]/i.test(depthNowRaw.trim())
    ? depthNowRaw.trim().toUpperCase().slice(0, 1)
    : null;

const prevDepthScoresRaw = (prevQc as any)?.depth_scores ?? {
  S: 0,
  R: 0,
  C: 0,
  I: 0,
  T: 0,
};

// prevDepthScores を 0..1 に正規化（互換: 0..100 の可能性も吸収）
const prevDepthScores: Record<string, number> = { S: 0, R: 0, C: 0, I: 0, T: 0 };
{
  const keys = ['S', 'R', 'C', 'I', 'T'];
  const rawVals = keys.map((k) =>
    typeof (prevDepthScoresRaw as any)?.[k] === 'number' ? (prevDepthScoresRaw as any)[k] : 0,
  );
  const max = Math.max(...rawVals);
  const scale = max > 1.00001 ? 100 : 1;

  for (const k of keys) {
    const v = typeof (prevDepthScoresRaw as any)?.[k] === 'number' ? (prevDepthScoresRaw as any)[k] : 0;
    prevDepthScores[k] = Math.max(0, Math.min(1, v / scale));
  }

  const sumPrev = Object.values(prevDepthScores).reduce((a, b) => a + b, 0);
  if (sumPrev > 0) {
    for (const k of keys) prevDepthScores[k] = prevDepthScores[k] / sumPrev;
  }
}

const newDepthScores: Record<string, number> = { S: 0, R: 0, C: 0, I: 0, T: 0 };

// EWMA更新（depthNow が無い時は “前回を保持”）
for (const k of Object.keys(newDepthScores)) {
  const prev = typeof prevDepthScores[k] === 'number' ? prevDepthScores[k] : 0;
  const base = 0.7 * prev;
  const add = depthNow === k ? 0.3 : 0;
  newDepthScores[k] = base + add;
}

// 正規化（合計1）
{
  const sum = Object.values(newDepthScores).reduce((a, b) => a + b, 0);
  if (sum > 0) {
    for (const k of Object.keys(newDepthScores)) newDepthScores[k] = newDepthScores[k] / sum;
  }
}

// dominantDepth決定
let dominantDepth: string | null = null;
let maxV = -1;
for (const k of Object.keys(newDepthScores)) {
  const v = typeof newDepthScores[k] === 'number' ? newDepthScores[k] : 0;
  if (v > maxV) {
    maxV = v;
    dominantDepth = k;
  }
}

// q_countsに保存（UI用）
(qcBase as any).depth_scores = newDepthScores;
(qcBase as any).depth_dominant = dominantDepth;
(qcBase as any).depth_updated_at = nowIso();

// ------------------------------------------------------------
// ✅ final anchor flags（B）
// - あるときだけ載せる（undefinedは触らない）
// - 入口は広く拾う（q_counts / extra / metaForSave のどこに居てもOK）
// ------------------------------------------------------------
const pickBool = (...vals: any[]): boolean | undefined => {
  for (const v of vals) {
    if (typeof v === 'boolean') return v;
  }
  return undefined;
};

const faPending = pickBool(
  (qCountsPicked as any)?.fa_pending,
  core?.q_counts?.fa_pending,
  unified?.q_counts?.fa_pending,
  extra?.fa_pending,
  extra?.final_anchor?.fa_pending,
  extra?.finalAnchor?.fa_pending,
  (metaForSave as any)?.fa_pending,
  (metaForSave as any)?.final_anchor?.fa_pending,
  (metaForSave as any)?.finalAnchor?.fa_pending,
);

const faLock = pickBool(
  (qCountsPicked as any)?.fa_lock,
  core?.q_counts?.fa_lock,
  unified?.q_counts?.fa_lock,
  extra?.fa_lock,
  extra?.final_anchor?.fa_lock,
  extra?.finalAnchor?.fa_lock,
  (metaForSave as any)?.fa_lock,
  (metaForSave as any)?.final_anchor?.fa_lock,
  (metaForSave as any)?.finalAnchor?.fa_lock,
);

// ------------------------------------------------------------
// ✅ it_triggered / it_triggered_true は “undefined を false に丸めない”
// ✅ 追加：phase_outer_smoothed を q_counts に保存（毎回計測の継続）
// ✅ FIX: 既に作った q_scores 等を “上書きで消さない”（merge）
// ------------------------------------------------------------
const shouldWriteQCountsBecausePhase = outerSmoothed != null;

if (qCountsPicked != null || shouldWriteQCountsBecausePhase) {
  // まず「既にpayloadに積んだq_counts」を正本として拾う（q_scores保持のため）
  const baseForQc = (upsertPayload as any)?.q_counts ?? qCountsPicked ?? null;
  const qc = normalizeQCounts(baseForQc);

  // ✅ it_triggered / it_triggered_true は “undefined を false に丸めない”
  const itTriggeredResolvedBool: boolean | undefined =
    typeof itTriggered === 'boolean'
      ? itTriggered
      : typeof (core as any)?.itTriggered === 'boolean'
        ? (core as any).itTriggered
        : typeof (metaForSave as any)?.itTriggered === 'boolean'
          ? (metaForSave as any).itTriggered
          : undefined;

  // 既存のit_triggered代入がこの下に続く前提なら、それはそのまま生かしてOK
  // ここでは phase の数値を “追加で” 合流するだけ
  if (outerSmoothed != null) {
    (qc as any).phase_outer_smoothed = outerSmoothed; // 0..1
    (qc as any).phase_outer_now = outerNow; // 0/1/null（暫定）
    (qc as any).phase_outer_updated_at = nowIso();
  }

  // ✅ 最後にmergeして確定（q_scores などを保持）
  upsertPayload.q_counts = { ...(upsertPayload as any)?.q_counts, ...(qc as any) };
}

    // ✅ anchor_event / anchor_write（DB列がある環境だけで使う。無い場合は retry で落とす）
    // ✅ decisionFinal を参照（override が必ず効く）
    if (anchorEntryDecisionFinal?.anchorEvent) upsertPayload.anchor_event = anchorEntryDecisionFinal.anchorEvent;
    if (anchorEntryDecisionFinal?.anchorWrite) upsertPayload.anchor_write = anchorEntryDecisionFinal.anchorWrite;

    // ✅ ITX列：方針（effectiveItxをそのまま保存）
    // - null（keep）のときは payloadに列を入れない
    if (itxForSave) {
      upsertPayload.itx_step = itxForSave.itx_step;
      upsertPayload.itx_anchor_event_type = itxForSave.itx_anchor_event_type;
      upsertPayload.itx_reason = itxForSave.itx_reason;
      upsertPayload.itx_last_at = itxForSave.itx_last_at;
    }

    // ✅ intent_anchor 更新（北極星ルール：set/reset以外は触らない）
    if (anchorWrite.action === 'set') {
      // 保存形は {key:"SUN"} に統一（text/phrase は混ぜない）
      upsertPayload.intent_anchor = { key: anchorKeyCandidate };
    } else if (anchorWrite.action === 'reset') {
      upsertPayload.intent_anchor = null;
    }

    // ✅ ログ（観測用）
    console.log('[IROS/STATE] upsert payload (intent_anchor check)', {
      userCode,
      anchor_action: anchorWrite.action,
      intent_anchor_will_set:
        anchorWrite.action === 'set' ? (upsertPayload.intent_anchor ?? null) : '(no-touch)',
      anchorKeyCandidate,
      fixedByMeta_intent_anchor_key: fixedByMeta.intent_anchor_key ?? null,
      anchorEntry_decision: anchorEntryDecisionFinal ?? null,
    });

// =========================================================
// [PHASE11] persist直前：anchorEntry が「DB write パスまで来てる」証明
// - core/meta から anchorEntry を拾う（extraも含む）
// - decisionFinal / upsertPayload 側の anchor_* / itx_* / intent_anchor を同時に観測
// =========================================================
{
  const ae =
    (core as any)?.anchorEntry ??
    (extra as any)?.anchorEntry ??
    (root as any)?.anchorEntry ??
    null;

  console.log('[IROS/PERSIST][anchorEntry][before-upsert]', {
    hasAnchorEntry: Boolean(ae),
    ae_hasDecision: Boolean(ae?.decision),
    ae_anchorWrite: ae?.decision?.anchorWrite ?? null,
    ae_anchorEvent: ae?.decision?.anchorEvent ?? null,
    ae_reason: ae?.decision?.reason ?? null,
    ae_evidence_source: ae?.evidence?.source ?? null,

    // ここが “最終決定” なので合わせて出す
    decisionFinal: anchorEntryDecisionFinal ?? null,

    // 実際にDBへ入れる予定の payload 側（ここが最重要）
    payload_has_anchor_event: 'anchor_event' in upsertPayload,
    payload_has_anchor_write: 'anchor_write' in upsertPayload,
    payload_anchor_event: upsertPayload.anchor_event ?? null,
    payload_anchor_write: upsertPayload.anchor_write ?? null,

    payload_has_itx_step: 'itx_step' in upsertPayload,
    payload_itx_step: upsertPayload.itx_step ?? null,
    payload_itx_reason: upsertPayload.itx_reason ?? null,
    payload_itx_last_at: upsertPayload.itx_last_at ?? null,
    payload_itx_anchor_event_type: upsertPayload.itx_anchor_event_type ?? null,

    payload_has_intent_anchor: 'intent_anchor' in upsertPayload,
    payload_intent_anchor: 'intent_anchor' in upsertPayload ? upsertPayload.intent_anchor : '(no-touch)',

    // 参考：meta側で見えてる key
    meta_intent_anchor_key: fixedByMeta.intent_anchor_key ?? null,
    anchorKeyCandidate: anchorKeyCandidate ?? null,
    anchor_action: anchorWrite.action,
  });
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

      // descent_gate 欠損
      if (missing('descent_gate') && 'descent_gate' in upsertPayload) {
        console.warn('[IROS/STATE] descent_gate missing in DB. retry without it.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.descent_gate;
        retried = true;
      }

      // anchor_event / anchor_write 欠損
      if (
        (missing('anchor_event') || missing('anchor_write')) &&
        ('anchor_event' in upsertPayload || 'anchor_write' in upsertPayload)
      ) {
        console.warn('[IROS/STATE] anchor_* missing in DB. drop and retry.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.anchor_event;
        delete upsertPayload.anchor_write;
        retried = true;
      }

      // itx_* 欠損（環境差）
      if (
        (missing('itx_') ||
          missing('itx_step') ||
          missing('itx_anchor') ||
          missing('itx_reason') ||
          missing('itx_last_at')) &&
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

      // intent_anchor 欠損（環境差）
      if (missing('intent_anchor') && 'intent_anchor' in upsertPayload) {
        console.warn('[IROS/STATE] intent_anchor missing in DB. drop and retry.', {
          userCode,
          code,
          message: msg,
        });
        delete upsertPayload.intent_anchor;
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
        itx_last_at: upsertPayload.itx_last_at ?? '(kept/none)',
        anchor_action: anchorWrite.action,
        anchor_event: upsertPayload.anchor_event ?? '(kept/none)',
        anchor_write: upsertPayload.anchor_write ?? '(kept/none)',
        intent_anchor:
          'intent_anchor' in upsertPayload ? upsertPayload.intent_anchor : '(no-touch)',
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
