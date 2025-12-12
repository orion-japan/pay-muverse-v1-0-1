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

/** JSON に流す前に、壊れたサロゲートペアを除去する */
function sanitizeJsonValue(value: any): any {
  if (typeof value === 'string') {
    // UTF-16 のサロゲート領域を全部削る（壊れた絵文字対策）
    // ※ extra 用なので、絵文字が消えるのは許容とする
    return value.replace(/[\uD800-\uDFFF]/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeJsonValue(v));
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizeJsonValue(v);
    }
    return out;
  }
  return value;
}

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
      typeof m.phase === 'string'
        ? m.phase
        : typeof unified.phase === 'string'
        ? unified.phase
        : null;

  const selfAcceptance: number | null =
    typeof m.selfAcceptance === 'number'
      ? m.selfAcceptance
      : typeof m.self_acceptance === 'number'
      ? m.self_acceptance
      : null;

  // --- Y / H レベル（揺れ・余白） -----------------------------
  const yLevel: number | null =
    typeof m.yLevel === 'number'
      ? Math.round(m.yLevel) // ★ smallint 用に整数に丸める
      : null;

  const hLevel: number | null =
    typeof m.hLevel === 'number'
      ? Math.round(m.hLevel) // ★ 2.25 → 2 などに丸める
      : null;

  // --- モード・IntentLine -------------------------------------
  const mirrorMode: string | null =
    typeof m.mode === 'string' ? m.mode : null;

  const intentSummary: string | null =
    typeof unified.intentSummary === 'string'
      ? unified.intentSummary
      : null;

  const intentLine: any = m.intentLine ?? null;

  // --- 状況サマリ / トピック（ベース値） ----------------------
  const baseSituationSummary: string | null =
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
    typeof baseSituationSummary === 'string' &&
    baseSituationSummary.trim()
      ? baseSituationSummary.trim()
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

  // --- situation_summary の最終決定 ---------------------------
  // 1) unified / meta に summary があればそれを優先
  // 2) なければ、analysisText を 200 文字まで切って保存
  let situationSummary: string | null = baseSituationSummary;
  if (!situationSummary || !situationSummary.trim()) {
    situationSummary =
      analysisText && analysisText.trim().length > 0
        ? analysisText.slice(0, 200)
        : null;
  }

  // 3) それでも空なら、inputText をトリムして 200 文字まで切る
  // 4) それでも空なら、最終保険として固定文言を入れる
  if (!situationSummary || !situationSummary.trim()) {
    const trimmedInput = (inputText ?? '').toString().trim();
    if (trimmedInput.length > 0) {
      situationSummary = trimmedInput.slice(0, 200);
    } else {
      situationSummary = '（内容なし）';
    }
  }

  // --- 挿入する行（まずは生の row） ---------------------------
  const rawRow = {
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

  // サロゲート除去を全体に適用
  const rowSanitized = sanitizeJsonValue(rawRow);

  console.log('[IROS][Training] insert sample', {
    user_code: rowSanitized.user_code,
    conversation_id: rowSanitized.conversation_id,
    q_code: rowSanitized.q_code,
    depth_stage: rowSanitized.depth_stage,
    phase: rowSanitized.phase,
    self_acceptance: rowSanitized.self_acceptance,
    situation_summary: rowSanitized.situation_summary,
    situation_topic: rowSanitized.situation_topic,
    y_level: rowSanitized.y_level,
    h_level: rowSanitized.h_level,
    target_kind: rowSanitized.target_kind,
    target_label: rowSanitized.target_label,
  });


  // ★ Supabase に送る前に JSON として正規化
  let rowToInsert: any = rowSanitized;
  try {
    rowToInsert = JSON.parse(JSON.stringify(rowSanitized));
  } catch (e) {
    console.error(
      '[IROS][Training] JSON sanitize failed, fallback to minimal payload',
      e,
    );
    rowToInsert = {
      user_code: rawRow.user_code,
      tenant_id: rawRow.tenant_id,
      conversation_id: rawRow.conversation_id,
      message_id: rawRow.message_id,
      source: rawRow.source,
      input_text: rawRow.input_text,
      analysis_text: rawRow.analysis_text,
      q_code: rawRow.q_code,
      depth_stage: rawRow.depth_stage,
      phase: rawRow.phase,
      self_acceptance: rawRow.self_acceptance,
      y_level: rawRow.y_level,
      h_level: rawRow.h_level,
      mirror_mode: rawRow.mirror_mode,
      intent_line: null,
      situation_summary: rawRow.situation_summary,
      situation_topic: rawRow.situation_topic,
      target_kind: rawRow.target_kind,
      target_label: rawRow.target_label,
      tags: Array.isArray(rawRow.tags) ? rawRow.tags : ['iros', 'auto'],
      extra: null,
    };
  }

  const { error } = await supabase
    .from('iros_training_samples')
    .insert(rowToInsert);

  if (error) {
    console.error('[IROS][Training] insert error', error);
  } else {
    console.log('[IROS][Training] insert ok');
  }
}
