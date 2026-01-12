// src/lib/iros/memoryState.ts
// Iros MemoryState（現在地レイヤー）読み書き
//
// ✅ 方針
// - このファイルでは Supabase client を生成しない（呼び出し元から受け取る）
// - load は必ず「DB row → IrosMemoryState」へ整形して返す
// - phase / spin_loop / spin_step / descent_gate も MemoryState として扱う
// - q_counts は「既存の構造（q_trace 等）を保持したまま it_cooldown だけ正規化」する
// - itx_*（IT連続性）は読み書き対象に含める（将来の判定/UIに使う）
// - intent_anchor（北極星/意図アンカー）は jsonb({key:'SUN', ...}) を想定し、state には key(string) で保持する
//
// ✅ 今回の修正ポイント（“会話の流れが読めてない”の根治寄り）
// - upsert の「undefined / null を潰さない」設計を厳密化（?? の罠を避ける）
//   - intentAnchor / itx* は undefined の時だけ prev を採用
//   - null を渡した場合は「明示的に消す」扱いにできる（= caller が意図している時だけ）
// - situationSummary / situationTopic / sentimentLevel も “空文字/薄い入力” で上書きしない
// - intent_anchor の保存形式を統一し、load 側は互換を広く拾う（{key}, {fixedNorthKey}, string）
// - 重要ログを一箇所で整形（diff が追える）
//
// ※ 既存DBや他ファイルの変更は不要（このファイル内で完結）

import type { SupabaseClient } from '@supabase/supabase-js';

/* =========================
 * Types
 * ========================= */

export type Phase = 'Inner' | 'Outer';
export type SpinLoop = 'SRI' | 'TCF';
export type DescentGate = 'closed' | 'offered' | 'accepted';

// いまの設計上、intentLayer は S/R/C/I/T を想定
export type IntentLayer = 'S' | 'R' | 'C' | 'I' | 'T';

export type QCounts = {
  it_cooldown?: number;
  // q_trace など、将来拡張フィールドを保持したいので open にする
  [k: string]: any;
};

export type IrosMemoryState = {
  userCode: string;

  // ★ 意図アンカー（SUN など）: state では key(string) で保持
  intentAnchor: string | null;

  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: Phase | null;

  intentLayer: IntentLayer | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  // ★ 回転状態
  spinLoop: SpinLoop | null;
  spinStep: number | null;
  descentGate: DescentGate | null;

  // ★ IT 連続性（T層ヒント等）
  itxStep: string | null; // 例: 'T2'
  itxAnchorEventType: string | null; // 例: 'none' | 'confirm' | 'set' | 'reset'
  itxReason: string | null; // 例: 'IT_TRIGGER_OK'
  itxLastAt: string | null;

  summary: string | null;
  updatedAt: string | null;

  sentimentLevel: string | null;

  situationSummary: string | null;
  situationTopic: string | null;

  qCounts: QCounts | null;
};

export type UpsertMemoryStateInput = {
  userCode: string;

  // ★ 意図アンカー（SUN など）: 入力は任意（undefined は維持 / null は明示消去）
  intentAnchor?: string | null;

  // ★ null 許容：ここは “空文字で上書きしない” だけ担保する
  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: Phase | null;

  intentLayer: IntentLayer | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  situationSummary: string | null;
  situationTopic: string | null;

  sentimentLevel: string | null;

  spinLoop: SpinLoop | null;
  spinStep: number | null;
  descentGate: DescentGate | null;

  // ★ IT 連続性（必要なときだけ渡せばOK。undefined は維持 / null は明示消去）
  itxStep?: string | null;
  itxAnchorEventType?: string | null;
  itxReason?: string | null;
  itxLastAt?: string | null;

  qCounts: QCounts | null;
};

/* =========================
 * Small utils
 * ========================= */

function isObj(v: unknown): v is Record<string, any> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function normString(v: any): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 ? s : null;
}

function normNumber(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normPhase(v: any): Phase | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  if (s === 'inner') return 'Inner';
  if (s === 'outer') return 'Outer';
  return null;
}

function normIntentLayer(v: any): IntentLayer | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (s === 'S' || s === 'R' || s === 'C' || s === 'I' || s === 'T') return s as IntentLayer;
  return null;
}

function normSpinLoop(v: any): SpinLoop | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return s === 'SRI' || s === 'TCF' ? (s as SpinLoop) : null;
}

function normSpinStep(v: any): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  // 上限は運用に合わせて調整（いまは 0..9）
  return Math.max(0, Math.min(9, n));
}

function normDescentGate(v: any): DescentGate | null {
  if (v == null) return null;

  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'closed' || s === 'offered' || s === 'accepted') return s as DescentGate;
    return null;
  }

  // 互換：旧 boolean（true=accepted / false=closed）
  if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

  return null;
}

function clampInt0to3(v: any): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.max(0, Math.min(3, Math.round(v)));
}

/**
 * 空文字・薄い文で上書きしない（会話の流れを壊す“ノイズ保存”を防ぐ）
 * - input が null の場合は「消す」意思なので許可
 * - input が '' / '   ' は prev を維持
 */
function preferNonEmptyString(input: any, prev: string | null): string | null {
  if (input === null) return null; // 明示消去
  const s = normString(input);
  if (s) return s;
  return prev ?? null;
}

/**
 * intent_anchor は jsonb({key:'SUN', ...}) を想定。
 * state では key(string) に落として持つ。
 * 互換:
 * - string('SUN')
 * - {key:'SUN'}
 * - {fixedNorthKey:'SUN'}（過去ログ互換）
 */
function normIntentAnchorKey(v: any): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return normString(v);
  if (typeof v === 'object') {
    const o = v as any;
    return normString(o.key) ?? normString(o.fixedNorthKey) ?? null;
  }
  return null;
}

/**
 * q_counts は「構造を保持」しつつ it_cooldown だけ正規化
 * - 既存の q_trace 等を落とさない
 */
function normalizeQCounts(v: any): QCounts | null {
  if (v == null) return null;
  if (typeof v !== 'object') return null;

  const out: QCounts = { ...(v as any) };

  const cd = clampInt0to3((v as any).it_cooldown);
  out.it_cooldown = cd ?? 0;

  return out;
}

/**
 * “undefined のときだけ prev を採用” を徹底するためのヘルパ
 * - input が undefined: prev
 * - input が null: null（明示消去）
 * - input が値: 値
 */
function pickOptional<T>(input: T | undefined, prev: T): T {
  return input === undefined ? prev : input;
}

/* =========================
 * LOAD
 * ========================= */

export async function loadIrosMemoryState(
  sb: SupabaseClient,
  userCode: string,
): Promise<IrosMemoryState | null> {
  const { data, error } = await sb
    .from('iros_memory_state')
    .select(
      [
        'user_code',
        'updated_at',
        // ★ intent_anchor（jsonb）
        'intent_anchor',
        'depth_stage',
        'q_primary',
        'self_acceptance',
        'phase',
        'intent_layer',
        'intent_confidence',
        'y_level',
        'h_level',
        'summary',
        'sentiment_level',
        'situation_summary',
        'situation_topic',
        'spin_loop',
        'spin_step',
        'descent_gate',
        'q_counts',
        // ★ IT 連続性
        'itx_step',
        'itx_anchor_event_type',
        'itx_reason',
        'itx_last_at',
      ].join(','),
    )
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const state: IrosMemoryState = {
    userCode: String((data as any).user_code),

    // ★ jsonb → key(string)
    intentAnchor: normIntentAnchorKey((data as any).intent_anchor),

    depthStage: normString((data as any).depth_stage),
    qPrimary: normString((data as any).q_primary),
    selfAcceptance: normNumber((data as any).self_acceptance),

    phase: normPhase((data as any).phase),

    intentLayer: normIntentLayer((data as any).intent_layer),
    intentConfidence: normNumber((data as any).intent_confidence),

    yLevel: normNumber((data as any).y_level),
    hLevel: normNumber((data as any).h_level),

    spinLoop: normSpinLoop((data as any).spin_loop),
    spinStep: normSpinStep((data as any).spin_step),
    descentGate: normDescentGate((data as any).descent_gate),

    itxStep: normString((data as any).itx_step),
    itxAnchorEventType: normString((data as any).itx_anchor_event_type),
    itxReason: normString((data as any).itx_reason),
    itxLastAt: (data as any).itx_last_at ?? null,

    summary: normString((data as any).summary),
    updatedAt: (data as any).updated_at ?? null,

    sentimentLevel: normString((data as any).sentiment_level),

    situationSummary: normString((data as any).situation_summary),
    situationTopic: normString((data as any).situation_topic),

    qCounts: normalizeQCounts((data as any).q_counts),
  };

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/STATE] loaded MemoryState', {
      userCode,
      hasMemory: true,
      intentAnchor: state.intentAnchor,
      depthStage: state.depthStage,
      qPrimary: state.qPrimary,
      selfAcceptance: state.selfAcceptance,
      phase: state.phase,
      intentLayer: state.intentLayer,
      yLevel: state.yLevel,
      hLevel: state.hLevel,
      spinLoop: state.spinLoop,
      spinStep: state.spinStep,
      descentGate: state.descentGate,
      itxStep: state.itxStep,
      itxAnchorEventType: state.itxAnchorEventType,
      itxReason: state.itxReason,
      itxLastAt: state.itxLastAt,
      sentimentLevel: state.sentimentLevel,
      situationSummary: state.situationSummary,
      situationTopic: state.situationTopic,
      qCounts: state.qCounts,
    });
  }

  return state;
}

/* =========================
 * UPSERT
 * ========================= */

export async function upsertIrosMemoryState(
  sb: SupabaseClient,
  input: UpsertMemoryStateInput,
): Promise<void> {
  const prev = await loadIrosMemoryState(sb, input.userCode);

  // 初回（prevが無い）でも落ちないように “空の prev” を用意
  const prevSafe: IrosMemoryState = prev ?? {
    userCode: input.userCode,
    intentAnchor: null,
    depthStage: null,
    qPrimary: null,
    selfAcceptance: null,
    phase: null,
    intentLayer: null,
    intentConfidence: null,
    yLevel: null,
    hLevel: null,
    spinLoop: null,
    spinStep: null,
    descentGate: null,
    itxStep: null,
    itxAnchorEventType: null,
    itxReason: null,
    itxLastAt: null,
    summary: null,
    updatedAt: null,
    sentimentLevel: null,
    situationSummary: null,
    situationTopic: null,
    qCounts: null,
  };

  // null なら潰さない（安定性優先）：ただし “空文字” は prev を維持
  const finalDepthStage = preferNonEmptyString(input.depthStage, prevSafe.depthStage);
  const finalQPrimary = preferNonEmptyString(input.qPrimary, prevSafe.qPrimary);

  const finalSelfAcceptance =
    typeof input.selfAcceptance === 'number'
      ? input.selfAcceptance
      : prevSafe.selfAcceptance ?? null;

  const finalPhase = input.phase ?? prevSafe.phase ?? null;

  const finalIntentLayer = input.intentLayer ?? prevSafe.intentLayer ?? null;

  const finalIntentConfidence =
    typeof input.intentConfidence === 'number'
      ? input.intentConfidence
      : prevSafe.intentConfidence ?? null;

  const finalYLevel = typeof input.yLevel === 'number' ? input.yLevel : prevSafe.yLevel ?? null;
  const finalHLevel = typeof input.hLevel === 'number' ? input.hLevel : prevSafe.hLevel ?? null;

  const yLevelInt = clampInt0to3(finalYLevel);
  const hLevelInt = clampInt0to3(finalHLevel);

  const finalSentimentLevel = preferNonEmptyString(input.sentimentLevel, prevSafe.sentimentLevel);

  const finalSpinLoop = input.spinLoop ?? prevSafe.spinLoop ?? null;
  const finalSpinStep =
    typeof input.spinStep === 'number' ? normSpinStep(input.spinStep) : prevSafe.spinStep ?? null;
  const finalDescentGate = input.descentGate ?? prevSafe.descentGate ?? null;

  // ★ intentAnchor（undefined のときだけ prev を採用 / null は明示消去）
  const finalIntentAnchor = pickOptional(input.intentAnchor, prevSafe.intentAnchor);

  // ★ IT 連続性（undefined のときだけ prev を採用 / null は明示消去）
  const finalItxStep = pickOptional(input.itxStep, prevSafe.itxStep);
  const finalItxAnchorEventType = pickOptional(input.itxAnchorEventType, prevSafe.itxAnchorEventType);
  const finalItxReason = pickOptional(input.itxReason, prevSafe.itxReason);
  const finalItxLastAt = pickOptional(input.itxLastAt, prevSafe.itxLastAt);

  // situation は “空文字/薄い入力” で上書きしない
  const finalSituationSummary = preferNonEmptyString(input.situationSummary, prevSafe.situationSummary);
  const finalSituationTopic = preferNonEmptyString(input.situationTopic, prevSafe.situationTopic);

  // q_counts は構造維持しつつ it_cooldown 正規化
  const finalQCounts = normalizeQCounts(input.qCounts) ?? normalizeQCounts(prevSafe.qCounts) ?? null;

  const summaryParts: string[] = [];
  if (finalIntentAnchor) summaryParts.push(`ia=${finalIntentAnchor}`);
  if (finalDepthStage) summaryParts.push(`depth=${finalDepthStage}`);
  if (finalQPrimary) summaryParts.push(`q=${finalQPrimary}`);
  if (typeof finalSelfAcceptance === 'number')
    summaryParts.push(`sa=${finalSelfAcceptance.toFixed(3)}`);
  if (typeof yLevelInt === 'number') summaryParts.push(`y=${yLevelInt}`);
  if (typeof hLevelInt === 'number') summaryParts.push(`h=${hLevelInt}`);
  if (finalPhase) summaryParts.push(`phase=${finalPhase}`);
  if (finalIntentLayer) summaryParts.push(`intent=${finalIntentLayer}`);
  if (typeof finalIntentConfidence === 'number')
    summaryParts.push(`ic=${finalIntentConfidence.toFixed(3)}`);
  if (finalSentimentLevel) summaryParts.push(`sent=${finalSentimentLevel}`);
  if (finalSpinLoop) summaryParts.push(`spin=${finalSpinLoop}`);
  if (typeof finalSpinStep === 'number') summaryParts.push(`step=${finalSpinStep}`);
  if (finalDescentGate) summaryParts.push(`descent=${finalDescentGate}`);
  if (finalItxStep) summaryParts.push(`itx=${finalItxStep}`);
  if (finalQCounts?.it_cooldown != null) summaryParts.push(`it_cd=${finalQCounts.it_cooldown}`);

  const summary = summaryParts.length ? summaryParts.join(',') : null;

  const payload = {
    user_code: input.userCode,

    // ★ DBは jsonb を想定：{key:'SUN'} で保存
    // - finalIntentAnchor が null の場合は null（明示消去）
    intent_anchor: finalIntentAnchor ? { key: finalIntentAnchor } : null,

    depth_stage: finalDepthStage,
    q_primary: finalQPrimary,
    self_acceptance: finalSelfAcceptance,
    phase: finalPhase,
    intent_layer: finalIntentLayer,
    intent_confidence: finalIntentConfidence,
    y_level: yLevelInt,
    h_level: hLevelInt,
    summary,
    updated_at: new Date().toISOString(),

    sentiment_level: finalSentimentLevel,
    situation_summary: finalSituationSummary,
    situation_topic: finalSituationTopic,

    spin_loop: finalSpinLoop,
    spin_step: finalSpinStep,
    descent_gate: finalDescentGate,

    // ★ IT 連続性
    itx_step: finalItxStep,
    itx_anchor_event_type: finalItxAnchorEventType,
    itx_reason: finalItxReason,
    itx_last_at: finalItxLastAt,

    q_counts: finalQCounts,
  };

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/STATE] upsert will write', {
      userCode: input.userCode,
      prev: {
        intentAnchor: prevSafe.intentAnchor,
        depthStage: prevSafe.depthStage,
        qPrimary: prevSafe.qPrimary,
        phase: prevSafe.phase,
        itxStep: prevSafe.itxStep,
      },
      next: {
        intentAnchor: finalIntentAnchor,
        depthStage: finalDepthStage,
        qPrimary: finalQPrimary,
        phase: finalPhase,
        itxStep: finalItxStep,
      },
    });
  }

  const { error } = await sb.from('iros_memory_state').upsert(payload, { onConflict: 'user_code' });

  if (error) {
    console.error('[IROS/STATE] upsert failed', { userCode: input.userCode, payload, error });
    throw error;
  }

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/STATE] upsert ok', {
      userCode: input.userCode,
      intentAnchor: finalIntentAnchor,
      depthStage: finalDepthStage,
      qPrimary: finalQPrimary,
      phase: finalPhase,
      spinLoop: finalSpinLoop,
      spinStep: finalSpinStep,
      descentGate: finalDescentGate,
      itxStep: finalItxStep,
      itxAnchorEventType: finalItxAnchorEventType,
      itxReason: finalItxReason,
      itxLastAt: finalItxLastAt,
      sentimentLevel: finalSentimentLevel,
      situationSummary: finalSituationSummary,
      situationTopic: finalSituationTopic,
      qCounts: finalQCounts,
    });
  }
}

// src/lib/iros/system.ts

// --- compatibility export ---
// mirra/generate.ts から import されるが、実装は用途ごとに後で詰められる。
// いまは「存在すること」が目的（typecheck を通す）。
export function naturalClose(..._args: any[]): string {
  return '';
}
