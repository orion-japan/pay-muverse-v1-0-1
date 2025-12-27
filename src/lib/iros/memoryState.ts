// src/lib/iros/memoryState.ts
// Iros MemoryState（現在地レイヤー）読み書き
//
// ✅ 方針
// - このファイルでは Supabase client を生成しない（呼び出し元から受け取る）
// - load は必ず「DB row → IrosMemoryState」へ整形して返す
// - phase / spin_loop / spin_step / descent_gate も MemoryState として扱う
// - q_counts は「既存の構造（q_trace 等）を保持したまま it_cooldown だけ正規化」する

import type { SupabaseClient } from '@supabase/supabase-js';

/* =========================
 * Types
 * ========================= */

export type Phase = 'Inner' | 'Outer';
export type SpinLoop = 'SRI' | 'TCF';
export type DescentGate = 'closed' | 'offered' | 'accepted';

export type QCounts = {
  it_cooldown?: number;
  // q_trace など、将来拡張フィールドを保持したいので open にする
  [k: string]: any;
};

export type IrosMemoryState = {
  userCode: string;

  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: Phase | null;

  intentLayer: string | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  // ★ 回転状態
  spinLoop: SpinLoop | null;
  spinStep: number | null;
  descentGate: DescentGate | null;

  summary: string | null;
  updatedAt: string | null;

  sentimentLevel: string | null;

  situationSummary: string | null;
  situationTopic: string | null;

  qCounts: QCounts | null;
};

export type UpsertMemoryStateInput = {
  userCode: string;

  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: Phase | null;

  intentLayer: string | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  situationSummary: string | null;
  situationTopic: string | null;

  sentimentLevel: string | null;

  spinLoop: SpinLoop | null;
  spinStep: number | null;
  descentGate: DescentGate | null;

  qCounts: QCounts | null;
};

/* =========================
 * Normalizers
 * ========================= */

function normString(v: any): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

function normNumber(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normPhase(v: any): Phase | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s === 'Inner' || s === 'Outer' ? (s as Phase) : null;
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
      ].join(','),
    )
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const state: IrosMemoryState = {
    userCode: String((data as any).user_code),

    depthStage: normString((data as any).depth_stage),
    qPrimary: normString((data as any).q_primary),
    selfAcceptance: normNumber((data as any).self_acceptance),

    phase: normPhase((data as any).phase),

    intentLayer: normString((data as any).intent_layer),
    intentConfidence: normNumber((data as any).intent_confidence),

    yLevel: normNumber((data as any).y_level),
    hLevel: normNumber((data as any).h_level),

    spinLoop: normSpinLoop((data as any).spin_loop),
    spinStep: normSpinStep((data as any).spin_step),
    descentGate: normDescentGate((data as any).descent_gate),

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

  // null なら潰さない（安定性優先）
  const finalDepthStage = input.depthStage ?? prev?.depthStage ?? null;
  const finalQPrimary = input.qPrimary ?? prev?.qPrimary ?? null;

  const finalSelfAcceptance =
    typeof input.selfAcceptance === 'number'
      ? input.selfAcceptance
      : prev?.selfAcceptance ?? null;

  const finalPhase = input.phase ?? prev?.phase ?? null;

  const finalIntentLayer = input.intentLayer ?? prev?.intentLayer ?? null;

  const finalIntentConfidence =
    typeof input.intentConfidence === 'number'
      ? input.intentConfidence
      : prev?.intentConfidence ?? null;

  const finalYLevel =
    typeof input.yLevel === 'number' ? input.yLevel : prev?.yLevel ?? null;

  const finalHLevel =
    typeof input.hLevel === 'number' ? input.hLevel : prev?.hLevel ?? null;

  const yLevelInt = clampInt0to3(finalYLevel);
  const hLevelInt = clampInt0to3(finalHLevel);

  const finalSentimentLevel =
    (typeof input.sentimentLevel === 'string' && input.sentimentLevel.length > 0)
      ? input.sentimentLevel
      : prev?.sentimentLevel ?? null;

  const finalSpinLoop = input.spinLoop ?? prev?.spinLoop ?? null;
  const finalSpinStep =
    typeof input.spinStep === 'number' ? normSpinStep(input.spinStep) : prev?.spinStep ?? null;
  const finalDescentGate = input.descentGate ?? prev?.descentGate ?? null;

  // q_counts は構造維持しつつ it_cooldown 正規化
  const finalQCounts =
    normalizeQCounts(input.qCounts) ?? normalizeQCounts(prev?.qCounts) ?? null;

  const summaryParts: string[] = [];
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
  if (finalQCounts?.it_cooldown != null) summaryParts.push(`it_cd=${finalQCounts.it_cooldown}`);

  const summary = summaryParts.length ? summaryParts.join(',') : null;

  const payload = {
    user_code: input.userCode,
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
    situation_summary: input.situationSummary ?? prev?.situationSummary ?? null,
    situation_topic: input.situationTopic ?? prev?.situationTopic ?? null,

    spin_loop: finalSpinLoop,
    spin_step: finalSpinStep,
    descent_gate: finalDescentGate,

    q_counts: finalQCounts,
  };

  const { error } = await sb
    .from('iros_memory_state')
    .upsert(payload, { onConflict: 'user_code' });

  if (error) {
    console.error('[IROS/STATE] upsert failed', { userCode: input.userCode, payload, error });
    throw error;
  }

  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    console.log('[IROS/STATE] upsert ok', {
      userCode: input.userCode,
      depthStage: finalDepthStage,
      qPrimary: finalQPrimary,
      phase: finalPhase,
      spinLoop: finalSpinLoop,
      spinStep: finalSpinStep,
      descentGate: finalDescentGate,
      qCounts: finalQCounts,
    });
  }
}
