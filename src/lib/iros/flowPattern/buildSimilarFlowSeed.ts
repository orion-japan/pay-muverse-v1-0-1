import type { SimilarFlowSnapshot } from './loadSimilarFlowSnapshots';

export type BuildSimilarFlowSeedInput = {
  matches: SimilarFlowSnapshot[];

  currentState?: {
    qCode?: string | null;
    qPrimary?: string | null;
    eTurn?: string | null;
    depthStage?: string | null;
    phase?: string | null;
  };

  limit?: number;
  maxChars?: number;
};

const cleanText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const oneLine = (value: unknown, max = 160): string => {
  const text = cleanText(value).replace(/\n+/g, ' ');
  if (!text) return '';
  return text.length > max ? text.slice(0, max) : text;
};

const safeValue = (value: unknown): string => {
  const text = oneLine(value, 80);
  return text || 'null';
};

const clamp = (value: string, maxChars: number): string => {
  if (value.length <= maxChars) return value;
  return value.slice(0, Math.max(0, maxChars - 20)).trimEnd() + '\n...truncated';
};

const isBadCreateTemplate = (value: unknown): boolean => {
  const t = cleanText(value);
  return /いま先に置く形は/u.test(t) ||
    /次に動く前に、今の自分の立ち位置を一つ置く形/u.test(t) ||
    /自分の中心を戻すための形/u.test(t) ||
    /戻りたい現実のイメージ/u.test(t) ||
    /その形から外れないことだけで十分/u.test(t);
};

export function buildSimilarFlowSeed(input: BuildSimilarFlowSeedInput): string | null {
  const matches = Array.isArray(input.matches) ? input.matches : [];

  if (matches.length <= 0) {
    return null;
  }

  const limit = Math.max(1, Math.min(Number(input.limit ?? 3), 5));
  const maxChars = Math.max(600, Math.min(Number(input.maxChars ?? 1600), 4000));
  const picked = matches.filter((match) => !isBadCreateTemplate(match.assistantTextHead)).slice(0, limit);

  const currentState = input.currentState ?? {};

  const lines: string[] = [
    'SIMILAR_FLOW_SEED (DO NOT OUTPUT):',
    'purpose=Use prior similar flow snapshots only as internal reading material.',
    'do_not_output_ids=true',
    'do_not_output_scores=true',
    'do_not_claim_memory_access=true',
    'writer_hint=Compare the shape of the flow, not surface events. Mention only what helps the current answer feel more accurate.',
    `current_state=qCode:${safeValue(currentState.qCode)} / qPrimary:${safeValue(currentState.qPrimary)} / eTurn:${safeValue(currentState.eTurn)} / depthStage:${safeValue(currentState.depthStage)} / phase:${safeValue(currentState.phase)}`,
    `matched_count=${picked.length}`,
  ];

  picked.forEach((match, index) => {
    lines.push('');
    lines.push(`match_${index + 1}:`);
    lines.push(`state=qCode:${safeValue(match.qCode)} / qPrimary:${safeValue(match.qPrimary)} / eTurn:${safeValue(match.eTurn)} / depthStage:${safeValue(match.depthStage)} / phase:${safeValue(match.phase)}`);
    lines.push(`situation_topic=${safeValue(match.situationTopic)}`);
    lines.push(`situation_summary=${oneLine(match.situationSummary, 180) || 'null'}`);
    lines.push(`user_text_head=${oneLine(match.userTextHead, 180) || 'null'}`);
    lines.push(`assistant_text_head=${oneLine(match.assistantTextHead, 180) || 'null'}`);
    lines.push(`reason=${oneLine(match.reason.join(', '), 220) || 'null'}`);
    lines.push(`created_at=${safeValue(match.createdAt)}`);
  });

  return clamp(lines.join('\n').trim(), maxChars);
}
