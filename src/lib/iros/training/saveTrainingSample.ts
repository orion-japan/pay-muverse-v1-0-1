// file: src/lib/iros/training/saveTrainingSample.ts

import type { SupabaseClient } from '@supabase/supabase-js';

export type SaveIrosTrainingSampleParams = {
  supabase: SupabaseClient;
  userCode: string;
  tenantId: string;
  conversationId: string;
  messageId?: string | null;
  inputText: string;        // ユーザー入力
  replyText?: string;       // Irosの返答（必要なら使う）
  meta: any;                // Orchestrator からの meta そのまま
  tags?: string[];          // ['iros','auto'] など
};

/**
 * Iros の推論結果を訓練用サンプルとして保存
 *  - input_text       : ユーザー入力
 *  - analysis_text    : unified.intentSummary（＝いまの構図）
 *  - q_code / depth_stage / self_acceptance : meta から抽出
 *  - intent_line      : meta.intentLine（JSONB）
 *  - situation_summary: そのターンの状況要約（1〜2行）
 *  - situation_topic  : 恋愛/仕事/自己などのざっくりカテゴリ
 *  - extra            : meta＋replyText をそのまま保存
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

  // Qコード
  const qCode: string | null =
    typeof m.qCode === 'string'
      ? m.qCode
      : typeof qObj.current === 'string'
      ? qObj.current
      : null;

  // 深度ステージ
  const depthStage: string | null =
    typeof m.depth === 'string'
      ? m.depth
      : typeof depthObj.stage === 'string'
      ? depthObj.stage
      : null;

  // 位相（Inner / Outer など）
  const phase: string | null =
    typeof unified.phase === 'string' ? unified.phase : null;

  // 自己肯定率
  const selfAcceptance: number | null =
    typeof m.selfAcceptance === 'number'
      ? m.selfAcceptance
      : typeof (m as any).self_acceptance === 'number'
      ? (m as any).self_acceptance
      : null;

  // mirror / consult などのモード
  const mirrorMode: string | null =
    typeof m.mode === 'string' ? m.mode : null;

  // 「いまの構図」＝ 小言テキスト（あれば）
  const intentSummary: string | null =
    typeof unified.intentSummary === 'string'
      ? unified.intentSummary
      : null;

  // intentLine 全体（nowLabel / coreNeed / riskHint ...）
  const intentLine: any = m.intentLine ?? null;

  // --- 💡 そのターンの状況サマリ／トピック ---
  const situation: any =
    unified.situation ?? m.situation ?? {}; // 将来の拡張も見越してフォールバック

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

  // --- 🔧 analysis_text 用テキスト（NOT NULL 対応のフォールバック）---
  const primary =
    typeof intentSummary === 'string' && intentSummary.trim().length > 0
      ? intentSummary.trim()
      : null;

  const fromSituation =
    !primary &&
    typeof situationSummary === 'string' &&
    situationSummary.trim().length > 0
      ? situationSummary.trim()
      : null;

  const fromIntentLine =
    !primary &&
    !fromSituation &&
    intentLine &&
    typeof intentLine.nowLabel === 'string' &&
    intentLine.nowLabel.trim().length > 0
      ? intentLine.nowLabel.trim()
      : null;

  // 最後の砦として inputText 先頭 120 文字
  const fallback =
    !primary && !fromSituation && !fromIntentLine
      ? (inputText ?? '').toString().slice(0, 120)
      : null;

  const analysisText: string =
    primary ?? fromSituation ?? fromIntentLine ?? fallback ?? '';

  const row = {
    user_code: userCode,
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_id: messageId,
    source: 'iros' as const,
    input_text: inputText,
    analysis_text: analysisText,          // ★ 必ず文字列を入れる
    q_code: qCode,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,
    mirror_mode: mirrorMode,
    intent_line: intentLine,              // ★ intentLine を JSONB で保存
    situation_summary: situationSummary,  // ★ 新カラム
    situation_topic: situationTopic,      // ★ 新カラム
    tags,
    extra: {
      meta: m,                            // meta 丸ごと
      replyText: replyText ?? null,       // 返答全文（必要なら学習に使えるように）
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
