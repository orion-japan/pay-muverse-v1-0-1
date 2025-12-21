// src/lib/iros/memoryState.ts
// Iros MemoryState（現在地レイヤー）読み書き
//
// ✅ 方針
// - createClient() を 0引数で呼ばない（ts(2554) 回避）
// - loadIrosMemoryState は「DB row → IrosMemoryState」へ必ず整形して返す（途中 return バグ除去）
// - phase / spin_loop / spin_step / descent_gate も MemoryState として扱えるようにする
// - 🆕 q_counts（it_cooldown 等）も MemoryState として扱う（ITデモのクールダウン土台）

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE ??
  // NOTE: どうしても service role が無い環境のための最後の逃げ道（本番では非推奨）
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL) {
  throw new Error('[IROS/MemoryState] NEXT_PUBLIC_SUPABASE_URL is missing');
}
if (!SERVICE_KEY) {
  throw new Error(
    '[IROS/MemoryState] SUPABASE_SERVICE_ROLE_KEY (or fallback key) is missing',
  );
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/**
 * DB ←→ Orchestrator で扱う MemoryState の統一型
 */
export type IrosMemoryState = {
  userCode: string;

  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: 'Inner' | 'Outer' | null;

  intentLayer: string | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  // ★ 回転状態
  spinLoop?: string | null;
  spinStep?: number | null;
  descentGate?: string | null;

  summary: string | null;
  updatedAt: string | null;

  // 🆕 ネガポジ方向（high / low / neutral 想定）
  sentimentLevel: string | null;

  // 🆕 場のテーマ保持用
  situationSummary?: string | null;
  situationTopic?: string | null;

  // 🆕 クールダウン等（JSONB想定）
  qCounts?: { it_cooldown?: number } | null;
};

/**
 * 外から保存するときに使う入力型
 */
export type UpsertMemoryStateInput = {
  userCode: string;

  depthStage: string | null;
  qPrimary: string | null;
  selfAcceptance: number | null;

  phase: 'Inner' | 'Outer' | null;

  intentLayer: string | null;
  intentConfidence: number | null;

  yLevel: number | null;
  hLevel: number | null;

  // 🆕 unified.situation 由来
  situationSummary: string | null;
  situationTopic: string | null;

  // 🆕 ネガポジ方向（'high' | 'low' | 'neutral' 想定）
  sentiment_level: string | null;

  // ★ 回転状態（必要なら渡す。null なら潰さない）
  spinLoop?: string | null;
  spinStep?: number | null;
  descentGate?: string | null;

  // 🆕 q_counts（必要なら渡す。null/undefined なら潰さない）
  qCounts?: { it_cooldown?: number } | null;
};

// ---------------------------------------------------------
// 🆕 q_counts normalize
// ---------------------------------------------------------
const normalizeQCounts = (v: any): { it_cooldown: number } | null => {
  if (v == null) return null;
  if (typeof v !== 'object') return null;

  const cdRaw = (v as any).it_cooldown;
  const cd =
    typeof cdRaw === 'number' && Number.isFinite(cdRaw)
      ? Math.max(0, Math.min(3, Math.round(cdRaw)))
      : 0;

  return { it_cooldown: cd };
};

/* =========================================================
   LOAD: iros_memory_state から 1行読み込む
========================================================= */

export async function loadIrosMemoryState(
  userCode: string,
): Promise<IrosMemoryState | null> {
  const { data, error } = await supabase
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
        // ★ 回転
        'spin_loop',
        'spin_step',
        'descent_gate',
        // 🆕 q_counts
        'q_counts',
      ].join(','),
    )
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const qCountsNorm = normalizeQCounts((data as any).q_counts);

  const state: IrosMemoryState = {
    userCode: data.user_code,

    depthStage: typeof data.depth_stage === 'string' ? data.depth_stage : null,
    qPrimary: typeof data.q_primary === 'string' ? data.q_primary : null,

    selfAcceptance:
      typeof data.self_acceptance === 'number' ? data.self_acceptance : null,

    phase: data.phase === 'Inner' || data.phase === 'Outer' ? data.phase : null,

    intentLayer:
      typeof data.intent_layer === 'string' ? data.intent_layer : null,
    intentConfidence:
      typeof data.intent_confidence === 'number' ? data.intent_confidence : null,

    yLevel: typeof data.y_level === 'number' ? data.y_level : null,
    hLevel: typeof data.h_level === 'number' ? data.h_level : null,

    // ★ 回転
    spinLoop: typeof data.spin_loop === 'string' ? data.spin_loop : null,
    spinStep: typeof data.spin_step === 'number' ? data.spin_step : null,
    descentGate:
      typeof data.descent_gate === 'string' ? data.descent_gate : null,

    summary: typeof data.summary === 'string' ? data.summary : null,
    updatedAt: data.updated_at ?? null,

    sentimentLevel:
      typeof data.sentiment_level === 'string' ? data.sentiment_level : null,

    situationSummary:
      typeof data.situation_summary === 'string' ? data.situation_summary : null,
    situationTopic:
      typeof data.situation_topic === 'string' ? data.situation_topic : null,

    // 🆕 q_counts
    qCounts: qCountsNorm,
  };

  if (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV !== 'production'
  ) {
    console.log('[IROS/ORCH v2] loaded MemoryState', {
      userCode,
      hasMemory: true,
      depthStage: state.depthStage,
      qPrimary: state.qPrimary,
      selfAcceptance: state.selfAcceptance,
      phase: state.phase,
      intentLayer: state.intentLayer,
      yLevel: state.yLevel,
      hLevel: state.hLevel,
      spinLoop: state.spinLoop ?? null,
      spinStep: state.spinStep ?? null,
      descentGate: state.descentGate ?? null,
      sentimentLevel: state.sentimentLevel,
      situationSummary: state.situationSummary,
      situationTopic: state.situationTopic,
      qCounts: state.qCounts ?? null,
    });
  }

  return state;
}

/* =========================================================
   UPSERT: iros_memory_state に 1行 upsert する
========================================================= */

export async function upsertIrosMemoryState(
  input: UpsertMemoryStateInput,
): Promise<void> {
  const {
    userCode,
    depthStage,
    qPrimary,
    selfAcceptance,
    phase,
    intentLayer,
    intentConfidence,
    yLevel,
    hLevel,
    situationSummary,
    situationTopic,
    sentiment_level,
    spinLoop,
    spinStep,
    descentGate,
    qCounts,
  } = input;

  // ① 既存の状態を読み込み（あればマージに使う）
  const previous = await loadIrosMemoryState(userCode);

  // ② null/undefined で「潰さない」フィールドはここでマージ
  const finalDepthStage = depthStage ?? previous?.depthStage ?? null;
  const finalQPrimary = qPrimary ?? previous?.qPrimary ?? null;

  const finalSelfAcceptance =
    typeof selfAcceptance === 'number'
      ? selfAcceptance
      : previous?.selfAcceptance ?? null;

  const finalPhase: 'Inner' | 'Outer' | null = phase ?? previous?.phase ?? null;

  const finalIntentLayer = intentLayer ?? previous?.intentLayer ?? null;

  const finalIntentConfidence =
    typeof intentConfidence === 'number'
      ? intentConfidence
      : previous?.intentConfidence ?? null;

  const finalYLevel =
    typeof yLevel === 'number' ? yLevel : previous?.yLevel ?? null;

  const finalHLevel =
    typeof hLevel === 'number' ? hLevel : previous?.hLevel ?? null;

  const finalSentimentLevel =
    typeof sentiment_level === 'string' && sentiment_level.length > 0
      ? sentiment_level
      : previous?.sentimentLevel ?? null;

  // ---------------------------------------------------------
  // ★ normalize helpers（このブロック内だけで完結）
  // ---------------------------------------------------------
  const normalizeSpinLoop = (v: any): 'SRI' | 'TCF' | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim().toUpperCase();
    return s === 'SRI' || s === 'TCF' ? (s as any) : null;
  };

  const normalizeSpinStep = (v: any): number | null => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    // spinStep は integer 前提（必要なら上限を変えてOK）
    const n = Math.round(v);
    return Math.max(0, Math.min(9, n)); // ← 上限は運用に合わせて調整可
  };

  const normalizeDescentGate = (
    v: any,
  ): 'closed' | 'offered' | 'accepted' | null => {
    if (v == null) return null;

    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'closed' || s === 'offered' || s === 'accepted') return s as any;
      return null;
    }

    // 互換：boolean のとき（旧）
    if (typeof v === 'boolean') return v ? 'accepted' : 'closed';

    return null;
  };

  // ★ 回転（null/undefined なら潰さない + “正規化” してから確定）
  const finalSpinLoop =
    normalizeSpinLoop(spinLoop) ??
    normalizeSpinLoop(previous?.spinLoop) ??
    null;

  const finalSpinStep =
    normalizeSpinStep(spinStep) ??
    normalizeSpinStep(previous?.spinStep) ??
    null;

  const finalDescentGate =
    normalizeDescentGate(descentGate) ??
    normalizeDescentGate(previous?.descentGate) ??
    null;

  // 🆕 q_counts（null/undefined なら潰さない + 正規化して確定）
  const finalQCounts =
    normalizeQCounts(qCounts) ?? normalizeQCounts(previous?.qCounts) ?? null;

  // ★ 0〜3 に丸めて integer 化（DB カラムは integer）
  const yLevelInt =
    typeof finalYLevel === 'number' && Number.isFinite(finalYLevel)
      ? Math.max(0, Math.min(3, Math.round(finalYLevel)))
      : null;

  const hLevelInt =
    typeof finalHLevel === 'number' && Number.isFinite(finalHLevel)
      ? Math.max(0, Math.min(3, Math.round(finalHLevel)))
      : null;

  // Debug summary
  const summaryParts: string[] = [];
  if (finalDepthStage) summaryParts.push(`depth=${finalDepthStage}`);
  if (finalQPrimary) summaryParts.push(`q=${finalQPrimary}`);
  if (typeof finalSelfAcceptance === 'number') {
    summaryParts.push(`sa=${finalSelfAcceptance.toFixed(3)}`);
  }
  if (typeof yLevelInt === 'number') summaryParts.push(`y=${yLevelInt}`);
  if (typeof hLevelInt === 'number') summaryParts.push(`h=${hLevelInt}`);
  if (finalPhase) summaryParts.push(`phase=${finalPhase}`);
  if (finalIntentLayer) summaryParts.push(`intent=${finalIntentLayer}`);
  if (typeof finalIntentConfidence === 'number') {
    summaryParts.push(`ic=${finalIntentConfidence.toFixed(3)}`);
  }
  if (typeof finalSentimentLevel === 'string' && finalSentimentLevel.length > 0) {
    summaryParts.push(`sent=${finalSentimentLevel}`);
  }
  if (finalSpinLoop) summaryParts.push(`spin=${finalSpinLoop}`);
  if (typeof finalSpinStep === 'number') summaryParts.push(`step=${finalSpinStep}`);
  if (finalDescentGate) summaryParts.push(`descent=${finalDescentGate}`);
  if (finalQCounts?.it_cooldown != null) summaryParts.push(`it_cd=${finalQCounts.it_cooldown}`);

  const summary = summaryParts.length > 0 ? summaryParts.join(',') : null;

  const payload = {
    user_code: userCode,
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

    // 🆕 追加分
    sentiment_level: finalSentimentLevel,
    situation_summary: situationSummary,
    situation_topic: situationTopic,

    // ★ 回転（正規化済み）
    spin_loop: finalSpinLoop,
    spin_step: finalSpinStep,
    descent_gate: finalDescentGate,

    // 🆕 q_counts（正規化済み / null なら DB のままにしたいなら upsert しない運用でもOK）
    q_counts: finalQCounts,
  };

  try {
    const { error } = await supabase
      .from('iros_memory_state')
      .upsert(payload, { onConflict: 'user_code' });

    if (error) {
      console.error('[IROS/MemoryState] upsert failed', {
        userCode,
        input,
        payload,
        error,
      });
    } else if (
      typeof process !== 'undefined' &&
      process.env.NODE_ENV !== 'production'
    ) {
      console.log('[IROS/MemoryState] upsert ok', {
        userCode,
        depthStage: finalDepthStage,
        qPrimary: finalQPrimary,
        selfAcceptance: finalSelfAcceptance,
        phase: finalPhase,
        intentLayer: finalIntentLayer,
        intentConfidence: finalIntentConfidence,
        yLevel: yLevelInt,
        hLevel: hLevelInt,
        sentiment_level: finalSentimentLevel,
        situationSummary,
        situationTopic,
        spinLoop: finalSpinLoop,
        spinStep: finalSpinStep,
        descentGate: finalDescentGate,
        qCounts: finalQCounts,
      });
    }
  } catch (e) {
    console.error('[IROS/MemoryState] unexpected upsert error', {
      userCode,
      input,
      error: e,
    });
  }
}
