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

export type TargetKind = 'stabilize' | 'expand' | 'pierce' | 'uncover';

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

function clampInt03(v: number | null): number | null {
  if (v == null) return null;
  const n = Math.round(v);
  return Math.max(0, Math.min(3, n));
}

/**
 * summary用のテキスト正規化
 * - 連続空白の圧縮
 * - “全体が同一パターンの繰り返し” を 1回に圧縮（例: A+A や A A、A…A）
 * - 長すぎる場合のトリム
 */
function normalizeTextForSummary(s: string | null, maxLen = 200): string | null {
  if (!s) return null;

  // 空白正規化
  let t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // “全体が同一パターンの繰り返し” を 1回に圧縮
  const collapseWholeRepetition = (text: string): string => {
    const n = text.length;
    if (n < 2) return text;

    // 2回繰り返し（半分一致）を高速チェック
    if (n % 2 === 0) {
      const half = n / 2;
      const a = text.slice(0, half);
      const b = text.slice(half);
      if (a === b) return a;
    }

    // 一般形：最小周期を探す（maxLen想定なので O(n^2)でもOK）
    for (let k = 1; k <= Math.floor(n / 2); k++) {
      if (n % k !== 0) continue;
      const unit = text.slice(0, k);
      const repeats = n / k;
      if (repeats <= 1) continue;
      if (unit.repeat(repeats) === text) return unit;
    }

    return text;
  };

  // 2回だけ試す（空白混在のケースも拾いやすくする）
  t = collapseWholeRepetition(t);
  t = collapseWholeRepetition(t);

  if (t.length > maxLen) return t.slice(0, maxLen) + '…';
  return t;
}

function normalizeTargetKind(v: any): TargetKind {
  const s = pickString(v);
  if (!s) return 'stabilize';

  const lowered = s.toLowerCase();
  if (lowered === 'stabilize') return 'stabilize';
  if (lowered === 'expand') return 'expand';
  if (lowered === 'pierce') return 'pierce';
  if (lowered === 'uncover') return 'uncover';

  return 'stabilize';
}

export async function saveIrosTrainingSample(params: SaveIrosTrainingSampleParams) {
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

  // ★ situation_summary は「ユーザー入力」最優先（新会話でも必ず埋まる）
  const situationSummaryFromMeta =
    pickString(meta?.situationSummary) ??
    pickString(meta?.situation_summary) ??
    pickString(meta?.unified?.situation?.summary) ??
    null;

  const situationSummary =
    normalizeTextForSummary(situationSummaryFromMeta, 200) ??
    normalizeTextForSummary(pickString(inputText), 200) ??
    '（内容なし）';

  const situationTopic =
    pickString(meta?.situationTopic) ??
    pickString(meta?.situation_topic) ??
    pickString(meta?.unified?.situation?.topic) ??
    null;

  // y/h（0〜3 int）
  const yLevelRaw =
    pickNumber(meta?.yLevel) ??
    pickNumber(meta?.y_level) ??
    pickNumber(meta?.unified?.yLevel) ??
    pickNumber(meta?.unified?.y_level) ??
    null;

  const hLevelRaw =
    pickNumber(meta?.hLevel) ??
    pickNumber(meta?.h_level) ??
    pickNumber(meta?.unified?.hLevel) ??
    pickNumber(meta?.unified?.h_level) ??
    null;

  const yLevel = clampInt03(yLevelRaw);
  const hLevel = clampInt03(hLevelRaw);

  // target_kind
  const targetKind = normalizeTargetKind(
    meta?.targetKind ??
      meta?.target_kind ??
      meta?.intentLine?.direction ??
      meta?.intent_line?.direction ??
      null,
  );

  const targetLabel =
    pickString(meta?.targetLabel) ?? pickString(meta?.target_label) ?? null;

  /**
   * ★重要：analysis_text には「返信」を入れる
   * - DBに reply_text 列が無いので analysis_text を “返信本文置き場” として使う
   * - intentSummary がある場合は extra に残し、analysis_text はまず replyText を優先
   */
  const analysisText =
    pickString(replyText) ??
    pickString(meta?.unified?.intentSummary) ??
    pickString(meta?.intentLine?.nowLabel) ??
    pickString(meta?.unified?.situation?.summary) ??
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

    y_level: yLevel,
    h_level: hLevel,

    mirror_mode: pickString(meta?.mode) ?? null,
    intent_line: meta?.intentLine ?? meta?.intent_line ?? null,

    situation_summary: situationSummary,
    situation_topic: situationTopic,

    target_kind: targetKind,
    target_label: targetLabel,

    tags,
    extra: {
      meta: meta ?? null,
      replyText: replyText ?? null,
      intentSummary: pickString(meta?.unified?.intentSummary) ?? null,
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
    throw error;
  }

  console.log('[IROS][Training] insert ok');
}
