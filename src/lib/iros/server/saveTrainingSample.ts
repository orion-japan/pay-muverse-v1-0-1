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

/**
 * target_kind 正規化
 * - 4分類（stabilize/expand/pierce/uncover）に必ず落とす
 * - Orchestrator の goal.kind が増えても、ここで汚染を止める
 */
function normalizeTargetKind(v: any): TargetKind {
  const s = pickString(v);
  if (!s) return 'stabilize';

  const lowered = s.toLowerCase();

  // 既存の正規値
  if (lowered === 'stabilize') return 'stabilize';
  if (lowered === 'expand') return 'expand';
  if (lowered === 'pierce') return 'pierce';
  if (lowered === 'uncover') return 'uncover';

  // Orchestrator/Will 側の kind からの橋渡し（重要）
  // - enableAction は forward 寄りなので expand に寄せる（stabilize に落とさない）
  if (lowered === 'enableaction') return 'expand';
  if (lowered === 'action') return 'expand';
  if (lowered === 'create') return 'expand';

  // 防御/安全/停止系は stabilize に寄せる
  if (lowered === 'safety') return 'stabilize';
  if (lowered === 'safe') return 'stabilize';
  if (lowered === 'brake') return 'stabilize';
  if (lowered === 'cooldown') return 'stabilize';

  return 'stabilize';
}

/**
 * Training 用 targetKind の決定（ここが“唯一の真実”）
 * 優先順位：
 * 1) meta.goal.kind（Orchestrator が確定したもの）【最優先】
 * 2) meta.targetKind / meta.target_kind（互換）
 * 3) meta.priority.goal.kind（念のため）
 * 4) intentLine.direction（既存の fallback）
 */
function resolveTrainingTargetKind(meta: any): TargetKind {
  const fromGoalKind = pickString(meta?.goal?.kind);
  if (fromGoalKind) return normalizeTargetKind(fromGoalKind);

  const fromMeta = pickString(meta?.targetKind) ?? pickString(meta?.target_kind) ?? null;
  if (fromMeta) return normalizeTargetKind(fromMeta);

  const fromPriorityKind = pickString(meta?.priority?.goal?.kind);
  if (fromPriorityKind) return normalizeTargetKind(fromPriorityKind);

  const fromIntentDir =
    pickString(meta?.intentLine?.direction) ?? pickString(meta?.intent_line?.direction) ?? null;
  if (fromIntentDir) return normalizeTargetKind(fromIntentDir);

  return 'stabilize';
}

// 本文（replyText）やユーザー入力（inputText）が analysis_text に混ざる事故を強制的に防ぐ
function normText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function sanitizeAnalysisTextForTraining(
  analysisText: unknown,
  replyText: unknown,
  inputText: unknown
): string | null {
  const a = typeof analysisText === 'string' ? analysisText.trim() : '';
  if (!a) return null;

  const r = typeof replyText === 'string' ? replyText.trim() : '';
  if (r && normText(a) === normText(r)) return null; // 同一なら本文混入

  const i = typeof inputText === 'string' ? inputText.trim() : '';
  if (i && normText(a) === normText(i)) return null; // 同一ならユーザー入力混入

  return a;
}

/**
 * analysis_text の安全fallback（“分析ラベル”）
 * - ユーザー入力を使わず、メタからのみ構成
 * - これで（内容なし）率を下げる
 */
function buildFallbackAnalysisLabel(args: {
  qCode: string | null;
  depthStage: string | null;
  phase: string | null;
  targetKind: TargetKind;
  situationTopic: string | null;
}): string {
  const parts: string[] = [];

  if (args.qCode) parts.push(`Q:${args.qCode}`);
  if (args.depthStage) parts.push(`D:${args.depthStage}`);
  if (args.phase) parts.push(`P:${args.phase}`);

  parts.push(`K:${args.targetKind}`);

  if (args.situationTopic) parts.push(`T:${args.situationTopic}`);

  // 何もなくても kind だけは必ず入る
  return parts.join(' / ');
}

/**
 * Postgres json/jsonb が嫌う「壊れたUnicode（サロゲート片割れ）」や循環参照を除去し、
 * かならず JSON として成立させる（PGRST102 / 22P02 の止血）。
 */
function sanitizeForJsonb(input: any): any {
  const stripBrokenSurrogates = (s: string) => {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);

      // high surrogate: 0xD800..0xDBFF
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;

        // valid pair with low surrogate: 0xDC00..0xDFFF
        if (next >= 0xdc00 && next <= 0xdfff) {
          out += s[i] + s[i + 1];
          i++; // consume low surrogate too
        } else {
          // broken high surrogate -> drop
        }
        continue;
      }

      // low surrogate without preceding high surrogate -> drop
      if (c >= 0xdc00 && c <= 0xdfff) {
        continue;
      }

      out += s[i];
    }
    return out;
  };

  const seen = new WeakSet<object>();

  const walk = (v: any): any => {
    if (v == null) return v;

    const t = typeof v;

    if (t === 'string') return stripBrokenSurrogates(v);
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'bigint') return String(v);
    if (t !== 'object') return v;

    if (v instanceof Date) return v.toISOString();

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return v.toString('base64');
    if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');

    if (seen.has(v)) return '[Circular]';
    seen.add(v);

    if (Array.isArray(v)) return v.map(walk);

    const o: any = {};
    for (const k of Object.keys(v)) {
      const val = (v as any)[k];
      if (val === undefined) continue; // JSON不可/不要
      o[k] = walk(val);
    }
    return o;
  };

  try {
    const cleaned = walk(input);
    return JSON.parse(JSON.stringify(cleaned));
  } catch {
    return {};
  }
}

/**
 * json/jsonb に渡す値を安全化
 * - "" / undefined は null に落とす（PGRST102回避）
 * - object/array は sanitize して JSON確定
 */
function jsonbOrNull(v: any) {
  if (v === '' || v === undefined || v == null) return null;
  if (typeof v === 'object') return sanitizeForJsonb(v);
  return null;
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
    pickString(meta?.qPrimary) ??
    pickString(meta?.q_primary) ??
    pickString(meta?.unified?.q?.current) ??
    null;

  const depthStage =
    pickString(meta?.depthStage) ??
    pickString(meta?.depth_stage) ??
    pickString(meta?.depth) ??
    pickString(meta?.unified?.depth?.stage) ??
    null;

  const phase = pickString(meta?.phase) ?? pickString(meta?.unified?.phase) ?? null;

  const selfAcceptance =
    pickNumber(meta?.selfAcceptance) ??
    pickNumber(meta?.self_acceptance) ??
    pickNumber(meta?.unified?.selfAcceptance) ??
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

  // target_kind（★ goal.kind を最優先にする）
  const targetKind = resolveTrainingTargetKind(meta);

  const targetLabel = pickString(meta?.targetLabel) ?? pickString(meta?.target_label) ?? null;

  /**
   * ★重要：analysis_text は「分析/メタ」専用
   * - ユーザー入力/返信本文と一致する候補は捨てる
   * - それでも空なら “分析ラベル” に落とす（ユーザー入力は使わない）
   */
  const analysisTextCandidate =
    pickString(meta?.unified?.intentSummary) ??
    pickString(meta?.unified?.intent_summary) ??
    pickString(meta?.intentLine?.nowLabel) ??
    pickString(meta?.intent_line?.nowLabel) ??
    pickString(meta?.intentLine?.guidanceHint) ??
    pickString(meta?.intent_line?.guidanceHint) ??
    pickString(meta?.intentLine?.riskHint) ??
    pickString(meta?.intent_line?.riskHint) ??
    pickString(meta?.goal?.reason) ??
    pickString(meta?.priority?.goal?.reason) ??
    null;

  const fallbackAnalysisLabel = buildFallbackAnalysisLabel({
    qCode,
    depthStage,
    phase,
    targetKind,
    situationTopic,
  });

  const analysisTextForTraining =
    sanitizeAnalysisTextForTraining(analysisTextCandidate, replyText, inputText) ??
    sanitizeAnalysisTextForTraining(fallbackAnalysisLabel, replyText, inputText) ??
    '（内容なし）';

  // ✅ json/jsonb 列の候補だけを安全化（PGRST102/22P02の止血）
  const intentLineRaw = meta?.intentLine ?? meta?.intent_line ?? null;

  const extraRaw = {
    meta: meta ?? null,
    replyText: replyText ?? null,
    intentSummary: pickString(meta?.unified?.intentSummary) ?? pickString(meta?.unified?.intent_summary) ?? null,
    analysisFallbackLabel: fallbackAnalysisLabel,
  };

  const payload = {
    user_code: userCode,
    tenant_id: tenantId,
    conversation_id: conversationId,
    message_id: messageId,

    source: 'iros',

    input_text: inputText,
    analysis_text: analysisTextForTraining,

    q_code: qCode,
    depth_stage: depthStage,
    phase,
    self_acceptance: selfAcceptance,

    y_level: yLevel,
    h_level: hLevel,

    mirror_mode: pickString(meta?.mode) ?? null,

    // ★ ここが PGRST102 の地雷になりやすい（json/jsonb想定）
    intent_line: jsonbOrNull(intentLineRaw),

    situation_summary: situationSummary,
    situation_topic: situationTopic,

    target_kind: targetKind,
    target_label: targetLabel,

    tags,

    // ★ ここも json/jsonb想定（meta を丸ごと持つので壊れUnicode/循環参照が混じりやすい）
    extra: jsonbOrNull(extraRaw),
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
