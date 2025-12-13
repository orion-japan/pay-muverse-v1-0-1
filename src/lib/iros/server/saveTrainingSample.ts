// src/lib/iros/server/saveTrainingSample.ts

import type { SupabaseClient } from '@supabase/supabase-js';

export type SaveIrosTrainingSampleParams = {
  supabase: SupabaseClient;

  userCode: string;
  tenantId?: string | null;
  conversationId: string;
  messageId?: string | null;

  inputText: string;
  replyText: string;

  meta: any;
  tags?: string[];
};

export type TargetKind =
  | 'stabilize'
  | 'expand'
  | 'pierce'
  | 'uncover';

function pickString(v: any): string | null {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  return null;
}

function pickNumber(v: any): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export async function saveIrosTrainingSample(
  params: SaveIrosTrainingSampleParams,
) {
  const {
    supabase,
    userCode,
    tenantId = null,
    conversationId,
    messageId = null,
    inputText,
    replyText,
    meta,
    tags = ['iros', 'auto'],
  } = params;

  // --- meta 抽出（camel/snake 両対応） ---
  const qCode =
    pickString(meta?.qCode) ??
    pickString(meta?.q_code) ??
    pickString(meta?.unified?.q?.current) ??
    null;

  const depthStage =
    pickString(meta?.depth) ??
    pickString(meta?.depth_stage) ??
    pickString(meta?.unified?.depth?.stage) ??
    null;

  const phase = pickString(meta?.phase) ?? pickString(meta?.unified?.phase) ?? null;

  const selfAcceptance =
    pickNumber(meta?.selfAcceptance) ??
    pickNumber(meta?.self_acceptance) ??
    pickNumber(meta?.unified?.self_acceptance) ??
    null;

  const situationSummary =
    pickString(meta?.situationSummary) ??
    pickString(meta?.situation_summary) ??
    pickString(meta?.unified?.situation?.summary) ??
    null;

  const situationTopic =
    pickString(meta?.situationTopic) ??
    pickString(meta?.situation_topic) ??
    pickString(meta?.unified?.situation?.topic) ??
    null;

  const yLevel =
    pickNumber(meta?.yLevel) ??
    pickNumber(meta?.y_level) ??
    null;

  const hLevel =
    pickNumber(meta?.hLevel) ??
    pickNumber(meta?.h_level) ??
    null;

  // ★ target_kind：まず meta 直下を優先 → 無ければ intentLine.direction → 最後は 'stabilize'
  const targetKind =
    pickString(meta?.targetKind) ??
    pickString(meta?.target_kind) ??
    pickString(meta?.intentLine?.direction) ??
    pickString(meta?.intent_line?.direction) ??
    'stabilize';

  const targetLabel =
    pickString(meta?.targetLabel) ??
    pickString(meta?.target_label) ??
    null;

  // DB列は reply_text が無いので、analysis_text に寄せる（replyText は extra に保存）
  const analysisText =
    pickString(meta?.unified?.intentSummary) ??
    situationSummary ??
    pickString(meta?.intentLine?.nowLabel) ??
    pickString(replyText) ??
    pickString(inputText) ??
    '（内容なし）';

  const payload = {
    user_code: userCode,
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_id: messageId,

    source: 'iros',

    input_text: inputText,
    analysis_text: analysisText,

    q_code: qCode,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,

    y_level: yLevel != null ? Math.round(yLevel) : null,
    h_level: hLevel != null ? Math.round(hLevel) : null,

    mirror_mode: pickString(meta?.mode) ?? null,
    intent_line: meta?.intentLine ?? meta?.intent_line ?? null,

    situation_summary: situationSummary ?? analysisText.slice(0, 200),
    situation_topic: situationTopic,

    target_kind: targetKind,
    target_label: targetLabel,

    tags,
    extra: {
      meta: meta ?? null,
      replyText: replyText ?? null,
    },
  };

  console.log('[IROS][Training] computed targetKind =', targetKind);
  console.log('[IROS][Training] insert sample', {
    user_code: payload.user_code,
    conversation_id: payload.conversation_id,
    message_id: payload.message_id,
    input_text: payload.input_text,
    analysis_text: payload.analysis_text,
    q_code: payload.q_code,
    depth_stage: payload.depth_stage,
    phase: payload.phase,
    self_acceptance: payload.self_acceptance,
    situation_summary: payload.situation_summary,
    situation_topic: payload.situation_topic,
    target_kind: payload.target_kind,
    target_label: payload.target_label,
    y_level: payload.y_level,
    h_level: payload.h_level,
  });

  const { error } = await supabase.from('iros_training_samples').insert(payload);

  if (error) {
    console.error('[IROS][Training] insert error', error);
    throw error; // route.ts 側で 500 にして原因が見えるようにする
  }

  console.log('[IROS][Training] insert ok');
}
