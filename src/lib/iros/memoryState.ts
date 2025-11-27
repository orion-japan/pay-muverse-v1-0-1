// src/lib/iros/memoryState.ts
// Iros MemoryState（現在地レイヤー）読み書き

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_SERVICE_ROLE ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

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
  summary: string | null;
  updatedAt: string | null;
  // 🆕 ネガポジ方向（high / low / neutral 想定）
  sentimentLevel: string | null;
  // 🆕 場のテーマ保持用
  situationSummary?: string | null;
  situationTopic?: string | null;
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
        'depth_stage',
        'q_primary',
        'self_acceptance',
        'phase',
        'intent_layer',
        'intent_confidence',
        'y_level',
        'h_level',
        'summary',
        'updated_at',
        // 🆕 追加カラム
        'sentiment_level',
        'situation_summary',
        'situation_topic',
      ].join(','),
    )
    .eq('user_code', userCode)
    .maybeSingle();

  if (error) {
    console.error('[IROS/MemoryState] load failed', { userCode, error });
    return null;
  }
  if (!data) return null;

  const state: IrosMemoryState = {
    userCode: data.user_code,
    depthStage: data.depth_stage,
    qPrimary: data.q_primary,
    selfAcceptance:
      typeof data.self_acceptance === 'number'
        ? data.self_acceptance
        : null,
    phase:
      data.phase === 'Inner' || data.phase === 'Outer'
        ? data.phase
        : null,
    intentLayer:
      typeof data.intent_layer === 'string' ? data.intent_layer : null,
    intentConfidence:
      typeof data.intent_confidence === 'number'
        ? data.intent_confidence
        : null,
    yLevel: typeof data.y_level === 'number' ? data.y_level : null,
    hLevel: typeof data.h_level === 'number' ? data.h_level : null,
    summary: typeof data.summary === 'string' ? data.summary : null,
    updatedAt: data.updated_at ?? null,
    sentimentLevel:
      typeof data.sentiment_level === 'string'
        ? data.sentiment_level
        : null,
    situationSummary:
      typeof data.situation_summary === 'string'
        ? data.situation_summary
        : null,
    situationTopic:
      typeof data.situation_topic === 'string'
        ? data.situation_topic
        : null,
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
      sentimentLevel: state.sentimentLevel,
      situationSummary: state.situationSummary,
      situationTopic: state.situationTopic,
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
  } = input;

  // ★ 0〜3 に丸めて integer 化（DB カラムは integer）
  const yLevelInt =
    typeof yLevel === 'number' && Number.isFinite(yLevel)
      ? Math.max(0, Math.min(3, Math.round(yLevel)))
      : null;

  const hLevelInt =
    typeof hLevel === 'number' && Number.isFinite(hLevel)
      ? Math.max(0, Math.min(3, Math.round(hLevel)))
      : null;

  // Debug summary（文字列なので小数もOKだが、見た目を揃えるため整数で）
  const summaryParts: string[] = [];
  if (depthStage) summaryParts.push(`depth=${depthStage}`);
  if (qPrimary) summaryParts.push(`q=${qPrimary}`);
  if (typeof selfAcceptance === 'number') {
    summaryParts.push(`sa=${selfAcceptance.toFixed(3)}`);
  }
  if (typeof yLevelInt === 'number') summaryParts.push(`y=${yLevelInt}`);
  if (typeof hLevelInt === 'number') summaryParts.push(`h=${hLevelInt}`);
  if (phase) summaryParts.push(`phase=${phase}`);
  if (intentLayer) summaryParts.push(`intent=${intentLayer}`);
  if (typeof intentConfidence === 'number') {
    summaryParts.push(`ic=${intentConfidence.toFixed(3)}`);
  }
  if (typeof sentiment_level === 'string' && sentiment_level.length > 0) {
    summaryParts.push(`sent=${sentiment_level}`);
  }

  const summary = summaryParts.length > 0 ? summaryParts.join(',') : null;

  const payload = {
    user_code: userCode,
    depth_stage: depthStage,
    q_primary: qPrimary,
    self_acceptance: selfAcceptance,
    phase,
    intent_layer: intentLayer,
    intent_confidence: intentConfidence,
    y_level: yLevelInt,
    h_level: hLevelInt,
    summary,
    updated_at: new Date().toISOString(),
    // 🆕 追加分
    sentiment_level,
    situation_summary: situationSummary,
    situation_topic: situationTopic,
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
        depthStage,
        qPrimary,
        selfAcceptance,
        phase,
        intentLayer,
        intentConfidence,
        yLevel: yLevelInt,
        hLevel: hLevelInt,
        sentiment_level,
        situationSummary,
        situationTopic,
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
