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

function clampInt03(v: number | null): number | null {
  if (v == null) return null;
  const n = Math.round(v);
  return Math.max(0, Math.min(3, n));
}

/**
 * summary用のテキスト正規化
 * - 連続空白の圧縮
 * - “同じ文字列の繰り返し” を 1回に圧縮（例: A+A や A A、A…A）
 * - 長すぎる場合のトリム
 */
function normalizeTextForSummary(s: string | null, maxLen = 200): string | null {
  if (!s) return null;

  // 空白正規化（日本語でも混ざる空白を潰す）
  let t = s.replace(/\s+/g, ' ').trim();
  if (!t) return null;

  // === 重複圧縮（全体が同一パターンの繰り返しなら、最小単位に潰す） ===
  // 例:
  // - "会社で…苦手会社で…苦手" → "会社で…苦手"
  // - "abc abc" → "abc"
  // - "aaaaaa" → "a"
  const collapseWholeRepetition = (text: string): string => {
    const n = text.length;
    if (n < 2) return text;

    // まずは “半分が同じ” を高速チェック（2回繰り返しケース）
    if (n % 2 === 0) {
      const half = n / 2;
      const a = text.slice(0, half);
      const b = text.slice(half);
      if (a === b) return a;
    }

    // 一般形：最小周期を探す（maxLen=200想定なので O(n^2)でもOK）
    // k = 周期長
    for (let k = 1; k <= Math.floor(n / 2); k++) {
      if (n % k !== 0) continue;
      const unit = text.slice(0, k);
      const repeats = n / k;
      if (repeats <= 1) continue;
      if (unit.repeat(repeats) === text) {
        return unit;
      }
    }

    return text;
  };

  // 1回圧縮して、さらに「空白あり繰り返し」も拾うためにもう一度だけ試す
  // （例: "A A" → 空白正規化後でも "A A" のままなので、全体周期で潰せる）
  t = collapseWholeRepetition(t);
  t = collapseWholeRepetition(t);

  // 末尾トリム
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

  const phase =
    pickString(meta?.phase) ??
    pickString(meta?.unified?.phase) ??
    null;

  const selfAcceptance =
    pickNumber(meta?.selfAcceptance) ??
    pickNumber(meta?.self_acceptance) ??
    pickNumber(meta?.unified?.self_acceptance) ??
    null;

  // ★ 新会話でも必ず埋まる：situation_summary は「ユーザー入力」を最優先にする
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

  // y/h（0〜3 integer）
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

  // ★ target_kind：meta直下 → intentLine.direction → default
  const targetKind = normalizeTargetKind(
    meta?.targetKind ??
      meta?.target_kind ??
      meta?.intentLine?.direction ??
      meta?.intent_line?.direction ??
      null,
  );

  const targetLabel =
    pickString(meta?.targetLabel) ??
    pickString(meta?.target_label) ??
    null;

  // DB列は reply_text が無いので analysis_text に寄せる（replyText は extra に保存）
  // ※ training_samples の analysis_text は「抽象化/意図の要約」なので unified.intentSummary を最優先
  const analysisText =
    pickString(meta?.unified?.intentSummary) ??
    pickString(meta?.unified?.situation?.summary) ??
    pickString(meta?.intentLine?.nowLabel) ??
    // ここで replyText を入れるのは “最後の最後” にする（inputText 優先）
    pickString(inputText) ??
    pickString(replyText) ??
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

    // ★ ここが肝：新会話でも必ず “ユーザー側の状況” が入る（重複は圧縮される）
    situation_summary: situationSummary,
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
