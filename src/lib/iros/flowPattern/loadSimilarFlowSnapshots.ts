import type { SupabaseClient } from '@supabase/supabase-js';

import type { FlowPatternSourceType } from './saveFlowPatternSnapshot';

export type SimilarFlowLookupInput = {
  supabase: SupabaseClient;
  userCode: string;

  conversationId?: string | null;
  excludeMessageId?: string | number | null;
  excludeSnapshotId?: string | null;

  sourceTypes?: FlowPatternSourceType[];

  targetLabel?: string | null;
  targetType?: string | null;

  qCode?: string | null;
  qPrimary?: string | null;
  eTurn?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  selfAcceptance?: number | null;

  relationFocus?: string | null;
  emotionalTemperature?: string | null;

  situationTopic?: string | null;
  situationSummary?: string | null;

  followupKind?: string | null;
  goalKind?: string | null;

  keywords?: string[];

  beforeCreatedAt?: string | null;

  recentLimit?: number;
  limit?: number;
};

export type SimilarFlowSnapshot = {
  id: string;
  score: number;
  reason: string[];

  sourceType: string | null;
  targetLabel: string | null;
  targetType: string | null;

  qCode: string | null;
  qPrimary: string | null;
  eTurn: string | null;
  depthStage: string | null;
  phase: string | null;
  selfAcceptance: number | null;

  relationFocus: string | null;
  emotionalTemperature: string | null;

  situationTopic: string | null;
  situationSummary: string | null;

  followupKind: string | null;
  goalKind: string | null;

  diagnosisId: number | null;
  userTextHead: string | null;
  assistantTextHead: string | null;

  conversationId: string | null;
  messageId: number | null;
  createdAt: string;
};

export type SimilarFlowLookupResult = {
  ok: boolean;
  matches: SimilarFlowSnapshot[];
  error?: unknown;
};

type FlowPatternRow = {
  id: string;
  source_type: string | null;
  target_label: string | null;
  target_type: string | null;

  q_code: string | null;
  q_primary: string | null;
  e_turn: string | null;
  depth_stage: string | null;
  phase: string | null;
  self_acceptance: number | string | null;

  relation_focus: string | null;
  emotional_temperature: string | null;

  situation_topic: string | null;
  situation_summary: string | null;

  followup_kind: string | null;
  goal_kind: string | null;

  diagnosis_id: number | string | null;
  user_text_head: string | null;
  assistant_text_head: string | null;

  conversation_id: string | null;
  message_id: number | string | null;
  created_at: string;
};

const cleanText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const asText = (value: unknown, max = 240): string | null => {
  const text = cleanText(value).replace(/\n+/g, ' ');
  if (!text) return null;
  return text.length > max ? text.slice(0, max) : text;
};

const asNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const sameText = (a: unknown, b: unknown): boolean => {
  const aa = cleanText(a).toLowerCase();
  const bb = cleanText(b).toLowerCase();
  return Boolean(aa && bb && aa === bb);
};

const compactText = (value: unknown): string => {
  return cleanText(value)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[、。,.!?！？「」『』()[\]{}【】]/g, '');
};

const tokenize = (value: unknown): string[] => {
  const text = cleanText(value).toLowerCase();
  if (!text) return [];

  return Array.from(
    new Set(
      text
        .split(/[\s、。,.!?！？「」『』()[\]{}【】/\\|:：;；"'`]+/g)
        .map((v) => v.trim())
        .filter((v) => v.length >= 2),
    ),
  ).slice(0, 24);
};

const textOverlapScore = (a: unknown, b: unknown): { score: number; reason: string[] } => {
  const aa = compactText(a);
  const bb = compactText(b);

  if (!aa || !bb) {
    return { score: 0, reason: [] };
  }

  if (aa === bb) {
    return { score: 10, reason: ['situation_text_exact'] };
  }

  const minLen = Math.min(aa.length, bb.length);
  if (minLen >= 6 && (aa.includes(bb) || bb.includes(aa))) {
    return { score: 8, reason: ['situation_text_contains'] };
  }

  const aTokens = tokenize(a);
  const bTokens = new Set(tokenize(b));
  const common = aTokens.filter((token) => bTokens.has(token));

  if (common.length <= 0) {
    return { score: 0, reason: [] };
  }

  return {
    score: Math.min(common.length * 2, 6),
    reason: [`situation_keyword_overlap:${common.slice(0, 5).join(',')}`],
  };
};

const isWithinDays = (dateText: unknown, days: number): boolean => {
  const time = Date.parse(String(dateText ?? ''));
  if (!Number.isFinite(time)) return false;
  return Date.now() - time <= days * 24 * 60 * 60 * 1000;
};

const addScore = (
  current: { score: number; reason: string[] },
  condition: boolean,
  score: number,
  reason: string,
): void => {
  if (!condition) return;
  current.score += score;
  current.reason.push(reason);
};

const scoreRow = (
  row: FlowPatternRow,
  input: SimilarFlowLookupInput,
): { score: number; reason: string[] } => {
  const current = { score: 0, reason: [] as string[] };

  addScore(current, sameText(row.target_label, input.targetLabel), 30, 'same_target_label');
  addScore(current, sameText(row.target_type, input.targetType), 10, 'same_target_type');

  addScore(current, sameText(row.relation_focus, input.relationFocus), 20, 'same_relation_focus');
  addScore(current, sameText(row.emotional_temperature, input.emotionalTemperature), 10, 'same_emotional_temperature');

  addScore(current, sameText(row.depth_stage, input.depthStage), 15, 'same_depth_stage');
  addScore(current, sameText(row.phase, input.phase), 10, 'same_phase');

  addScore(current, sameText(row.q_primary, input.qPrimary), 10, 'same_q_primary');
  addScore(current, sameText(row.e_turn, input.eTurn), 10, 'same_e_turn');
  addScore(current, sameText(row.q_code, input.qCode), 6, 'same_q_code');

  addScore(current, sameText(row.followup_kind, input.followupKind), 5, 'same_followup_kind');
  addScore(current, sameText(row.goal_kind, input.goalKind), 5, 'same_goal_kind');

  addScore(current, sameText(row.conversation_id, input.conversationId), 5, 'same_conversation');
  addScore(current, isWithinDays(row.created_at, 30), 5, 'within_30_days');

  const topicVsTopic = textOverlapScore(row.situation_topic, input.situationTopic);
  if (topicVsTopic.score > 0) {
    current.score += Math.min(topicVsTopic.score, 10);
    current.reason.push(...topicVsTopic.reason.map((r) => `topic:${r}`));
  }

  const summaryVsSummary = textOverlapScore(row.situation_summary, input.situationSummary);
  if (summaryVsSummary.score > 0) {
    current.score += Math.min(summaryVsSummary.score, 8);
    current.reason.push(...summaryVsSummary.reason.map((r) => `summary:${r}`));
  }

  const topicVsKeywords = textOverlapScore(
    [row.situation_topic, row.situation_summary, row.user_text_head].filter(Boolean).join(' '),
    input.keywords?.join(' ') ?? '',
  );

  if (topicVsKeywords.score > 0) {
    current.score += Math.min(topicVsKeywords.score, 6);
    current.reason.push(...topicVsKeywords.reason.map((r) => `keywords:${r}`));
  }

  return current;
};

const toMatch = (
  row: FlowPatternRow,
  scored: { score: number; reason: string[] },
): SimilarFlowSnapshot => {
  return {
    id: row.id,
    score: scored.score,
    reason: scored.reason,

    sourceType: row.source_type ?? null,
    targetLabel: row.target_label ?? null,
    targetType: row.target_type ?? null,

    qCode: row.q_code ?? null,
    qPrimary: row.q_primary ?? null,
    eTurn: row.e_turn ?? null,
    depthStage: row.depth_stage ?? null,
    phase: row.phase ?? null,
    selfAcceptance: asNumber(row.self_acceptance),

    relationFocus: row.relation_focus ?? null,
    emotionalTemperature: row.emotional_temperature ?? null,

    situationTopic: row.situation_topic ?? null,
    situationSummary: row.situation_summary ?? null,

    followupKind: row.followup_kind ?? null,
    goalKind: row.goal_kind ?? null,

    diagnosisId: asNumber(row.diagnosis_id),
    userTextHead: row.user_text_head ?? null,
    assistantTextHead: row.assistant_text_head ?? null,

    conversationId: row.conversation_id ?? null,
    messageId: asNumber(row.message_id),
    createdAt: row.created_at,
  };
};

export async function loadSimilarFlowSnapshots(
  input: SimilarFlowLookupInput,
): Promise<SimilarFlowLookupResult> {
  const supabase = input.supabase;
  const userCode = cleanText(input.userCode);

  if (!supabase || !userCode) {
    return {
      ok: false,
      matches: [],
      error: 'missing_supabase_or_user_code',
    };
  }

  const sourceTypes =
    input.sourceTypes && input.sourceTypes.length > 0
      ? input.sourceTypes
      : (['chat'] as FlowPatternSourceType[]);

  const recentLimit = Math.max(10, Math.min(Number(input.recentLimit ?? 80), 200));
  const limit = Math.max(1, Math.min(Number(input.limit ?? 3), 10));

  try {
    let query = (supabase as any)
      .from('iros_flow_pattern_snapshots')
      .select(
        [
          'id',
          'source_type',
          'target_label',
          'target_type',
          'q_code',
          'q_primary',
          'e_turn',
          'depth_stage',
          'phase',
          'self_acceptance',
          'relation_focus',
          'emotional_temperature',
          'situation_topic',
          'situation_summary',
          'followup_kind',
          'goal_kind',
          'diagnosis_id',
          'user_text_head',
          'assistant_text_head',
          'conversation_id',
          'message_id',
          'created_at',
        ].join(','),
      )
      .eq('user_code', userCode)
      .in('source_type', sourceTypes)
      .order('created_at', { ascending: false })
      .limit(recentLimit);

    const excludeMessageId = asNumber(input.excludeMessageId);
    if (excludeMessageId !== null) {
      query = query.neq('message_id', excludeMessageId);
    }

    const excludeSnapshotId = asText(input.excludeSnapshotId, 80);
    if (excludeSnapshotId) {
      query = query.neq('id', excludeSnapshotId);
    }

    const beforeCreatedAt = asText(input.beforeCreatedAt, 80);
    if (beforeCreatedAt) {
      query = query.lt('created_at', beforeCreatedAt);
    }

    const { data, error } = await query;

    if (error) {
      return {
        ok: false,
        matches: [],
        error,
      };
    }

    const rows = Array.isArray(data) ? (data as FlowPatternRow[]) : [];

    const matches = rows
      .map((row) => {
        const scored = scoreRow(row, input);
        return toMatch(row, scored);
      })
      .filter((match) => match.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      })
      .slice(0, limit);

    return {
      ok: true,
      matches,
    };
  } catch (error) {
    return {
      ok: false,
      matches: [],
      error,
    };
  }
}
