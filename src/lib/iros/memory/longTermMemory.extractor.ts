// src/lib/iros/memory/longTermMemory.extractor.ts
// iros — Long Term Memory extractor v1
// 目的：ユーザー発話から「長期保存候補」を抽出する（まだ保存はしない）

import {
  ExtractDurableMemoriesArgs,
  LongTermMemoryCandidate
} from './longTermMemory.types';
import { matchLongTermMemoryClusterV1 } from './longTermMemory.cluster';

const RULE_PATTERNS = [
  /今後/,
  /これから/,
  /以後/,
  /必ず/,
  /毎回/,
  /覚えておいて/,
  /前提にして/,
  /このルール/,
];

function normalizeText(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[。、．,.!！?？]/g, '')
    .replace(/\s+/g, ' ');
}

function looksLikeRule(text: string) {
  return RULE_PATTERNS.some((r) => r.test(text));
}

function detectMemoryType(text: string) {
  if (text.includes('コード') || text.includes('修正') || text.includes('SQL'))
    return 'working_rule';

  if (text.includes('Tailwind') || text.includes('日本語'))
    return 'preference';

  if (text.includes('IROS') || text.includes('Muverse'))
    return 'project_context';

  return 'durable_fact';
}

function buildKey(text: string) {
  const base = normalizeText(text);

  return base
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fa5 ]/g, '')
    .slice(0, 80);
}

export function extractDurableMemoriesV1(
  args: ExtractDurableMemoriesArgs
): LongTermMemoryCandidate[] {
  const { userText, conversationId, traceId } = args;

  if (!userText) return [];

  const sourceLines = userText
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);

  const candidates: LongTermMemoryCandidate[] = [];
  const seen = new Set<string>();

  for (const sourceLine of sourceLines) {
    const lineHasRuleSignal = looksLikeRule(sourceLine);

    const rawUnits = sourceLine
      .split(/[。]+/)
      .map((v) => v.trim())
      .filter(Boolean);

    for (const unit of rawUnits) {
      const line = unit.trim();
      if (!line) continue;

      const inferredMemoryType = detectMemoryType(line);
      const memoryType =
        inferredMemoryType === 'durable_fact' &&
        /一括で出さない|まとめて出さない|1つずつ|一つずつ|推測で修正しない|憶測で修正しない|未確認で修正しない|確認してから修正|コードまたはsqlで確認/i.test(
          line,
        )
          ? 'working_rule'
          : inferredMemoryType;

      const shouldKeep =
        lineHasRuleSignal ||
        looksLikeRule(line) ||
        memoryType === 'working_rule';

      if (!shouldKeep) continue;

      const cluster = matchLongTermMemoryClusterV1({
        memoryType,
        valueText: line,
      });

      const valueText = cluster.canonicalValueText ?? line;
      const key = cluster.clusterKey ?? buildKey(valueText);

      if (!key || seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        memoryType,
        key,
        valueText,
        normalizedText: normalizeText(valueText),
        clusterKey: cluster.clusterKey ?? null,
        priority: 60,
        confidence: 0.75,
        source: 'auto',
        evidence: {
          conversationId: conversationId ?? null,
          traceId: traceId ?? null,
          excerpt: line,
          extractedFrom: 'user'
        }
      });
    }
  }

  return candidates;
}
