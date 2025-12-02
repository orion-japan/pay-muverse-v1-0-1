// file: src/lib/iros/training/saveTrainingSample.ts

import type { SupabaseClient } from '@supabase/supabase-js';

export type SaveIrosTrainingSampleParams = {
  supabase: SupabaseClient;   // 型で怒られにくいよう any にしておく
  userCode: string;
  tenantId: string;
  conversationId: string;
  messageId?: string | null;
  inputText: string;        // ユーザー入力
  replyText?: string;       // Iros の返答（必要なら使う）
  meta: any;                // Orchestrator からの meta そのまま
  tags?: string[];          // ['iros','auto'] など
};

/**
 * Iros の推論結果を訓練用サンプルとして保存
 *  - input_text        : ユーザー入力
 *  - analysis_text     : unified.intentSummary / situation.summary / intentLine.nowLabel のいずれか
 *  - q_code            : meta.qCode / unified.q.current
 *  - depth_stage       : meta.depth / unified.depth.stage
 *  - phase             : unified.phase
 *  - self_acceptance   : meta.selfAcceptance / meta.self_acceptance
 *  - y_level / h_level : meta.yLevel / meta.hLevel
 *  - target_kind/label : ir診断ターゲット（自分 / 上司 など）
 *  - situation_*       : unified.situation.* / meta.situation*
 *  - extra             : meta + replyText を丸ごと JSONB 保存
 */
export async function saveIrosTrainingSample(
  params: SaveIrosTrainingSampleParams,
): Promise<void> {
  const {
    supabase,
    userCode,
    tenantId,
    conversationId,
    messageId = null,
    inputText,
    replyText,
    meta,
    tags = ['iros', 'auto'],
  } = params;

  const m: any = meta ?? {};
  const unified: any = m.unified ?? {};
  const qObj: any = unified.q ?? {};
  const depthObj: any = unified.depth ?? {};
  const situation: any = unified.situation ?? m.situation ?? {};

  // --- Q / Depth / Phase / SA ---------------------------------
  const qCode: string | null =
    typeof m.qCode === 'string'
      ? m.qCode
      : typeof qObj.current === 'string'
      ? qObj.current
      : null;

  const depthStage: string | null =
    typeof m.depth === 'string'
      ? m.depth
      : typeof depthObj.stage === 'string'
      ? depthObj.stage
      : null;

  const phase: string | null =
    typeof unified.phase === 'string' ? unified.phase : null;

  const selfAcceptance: number | null =
    typeof m.selfAcceptance === 'number'
      ? m.selfAcceptance
      : typeof m.self_acceptance === 'number'
      ? m.self_acceptance
      : null;

  // --- Y / H レベル（揺れ・余白） -----------------------------
  const yLevel: number | null =
    typeof m.yLevel === 'number' ? m.yLevel : null;

  const hLevel: number | null =
    typeof m.hLevel === 'number' ? m.hLevel : null;

  // --- モード・IntentLine -------------------------------------
  const mirrorMode: string | null =
    typeof m.mode === 'string' ? m.mode : null;

  const intentSummary: string | null =
    typeof unified.intentSummary === 'string'
      ? unified.intentSummary
      : null;

  const intentLine: any = m.intentLine ?? null;

  // --- 状況サマリ / トピック ---------------------------------
  const situationSummary: string | null =
    typeof situation.summary === 'string'
      ? situation.summary
      : typeof m.situationSummary === 'string'
      ? m.situationSummary
      : null;

  const situationTopic: string | null =
    typeof situation.topic === 'string'
      ? situation.topic
      : typeof m.situationTopic === 'string'
      ? m.situationTopic
      : null;

  // --- ir診断ターゲット（自分 / 上司 など） -------------------
  const targetKind: string | null =
    typeof m.irTargetType === 'string' ? m.irTargetType : null;

  const targetLabel: string | null =
    typeof m.irTargetText === 'string' ? m.irTargetText : null;

  // --- analysis_text（NOT NULL 用の本文） ----------------------
  const primary =
    typeof intentSummary === 'string' && intentSummary.trim()
      ? intentSummary.trim()
      : null;

  const fromSituation =
    !primary &&
    typeof situationSummary === 'string' &&
    situationSummary.trim()
      ? situationSummary.trim()
      : null;

  const fromIntentLine =
    !primary &&
    !fromSituation &&
    intentLine &&
    typeof intentLine.nowLabel === 'string' &&
    intentLine.nowLabel.trim()
      ? intentLine.nowLabel.trim()
      : null;

  const fallback =
    !primary && !fromSituation && !fromIntentLine
      ? (inputText ?? '').toString().slice(0, 120)
      : null;

  const analysisText: string =
    primary ?? fromSituation ?? fromIntentLine ?? fallback ?? '';

  // --- 挿入する行 ---------------------------------------------
  const row = {
    user_code: userCode,
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_id: messageId,
    source: 'iros' as const,
    input_text: inputText,
    analysis_text: analysisText,
    q_code: qCode,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,
    y_level: yLevel,
    h_level: hLevel,
    mirror_mode: mirrorMode,
    intent_line: intentLine,
    situation_summary: situationSummary,
    situation_topic: situationTopic,
    target_kind: targetKind,
    target_label: targetLabel,
    tags,
    extra: {
      meta: m,
      replyText: replyText ?? null,
    },
  };

  console.log('[IROS][Training] insert sample', {
    user_code: row.user_code,
    conversation_id: row.conversation_id,
    q_code: row.q_code,
    depth_stage: row.depth_stage,
    self_acceptance: row.self_acceptance,
    situation_summary: row.situation_summary,
    situation_topic: row.situation_topic,
    y_level: row.y_level,
    h_level: row.h_level,
    target_kind: row.target_kind,
    target_label: row.target_label,
  });

  const { error } = await supabase
    .from('iros_training_samples')
    .insert(row);

  if (error) {
    console.error('[IROS][Training] insert error', error);
  } else {
    console.log('[IROS][Training] insert ok');
  }
}
