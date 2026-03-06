// src/lib/iros/memory/longTermMemory.selector.ts
// iros — Long Term Memory selector v1
// 目的：長期メモリーを「必要なものだけ軽く」選ぶ

import type { LongTermMemoryRow, LongTermMemoryType } from './longTermMemory.types';

export type SelectLongTermMemoriesArgs = {
  rows: LongTermMemoryRow[];
  userText?: string | null;
  maxItems?: number;
};

function norm(text: string): string {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[。、．,.!！?？]/g, ' ')
    .replace(/\s+/g, ' ');
}

function tokenizeJaLite(text: string): string[] {
  const s = norm(text);
  if (!s) return [];
  return Array.from(
    new Set(
      s
        .split(/[\s/|｜・、]+/)
        .map((v) => v.trim())
        .filter((v) => v.length >= 2)
    )
  );
}

function containsAny(text: string, words: string[]): boolean {
  return words.some((w) => w && text.includes(w));
}

function relevanceScore(row: LongTermMemoryRow, userText: string): number {
  const t = norm(userText);
  const value = norm(row.value_text ?? '');
  const key = norm(row.key ?? '');
  const cluster = norm(row.cluster_key ?? '');

  if (!t) return 0;

  let score = 0;
  const tokens = tokenizeJaLite(t);

  if (containsAny(value, tokens)) score += 3;
  if (containsAny(key, tokens)) score += 2;
  if (cluster && containsAny(cluster, tokens)) score += 2;

  // 開発相談っぽい語があれば working_rule を少し優先
  if (
    row.memory_type === 'working_rule' &&
    /(コード|sql|修正|確認|実装|関数|import|型|tsc|supabase)/i.test(userText)
  ) {
    score += 2;
  }

  return score;
}

function typeCap(type: LongTermMemoryType): number {
  switch (type) {
    case 'working_rule':
      return 2;
    case 'preference':
      return 1;
    case 'project_context':
      return 1;
    case 'durable_fact':
      return 1;
    default:
      return 1;
  }
}

function priorityNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 50;
}

export function selectLongTermMemoriesV1(
  args: SelectLongTermMemoriesArgs
): LongTermMemoryRow[] {
  const { rows, maxItems = 4 } = args;
  const userText = typeof args.userText === 'string' ? args.userText : '';

  if (!Array.isArray(rows) || rows.length === 0) return [];

  const ranked = [...rows]
    .filter((row) => row.status === 'active')
    .map((row) => ({
      row,
      relevance: relevanceScore(row, userText),
      priority: priorityNum(row.priority),
    }))
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return b.priority - a.priority;
    });

  const picked: LongTermMemoryRow[] = [];
  const usedCluster = new Set<string>();
  const typeCount = new Map<LongTermMemoryType, number>();

  for (const item of ranked) {
    const row = item.row;
    const mt = row.memory_type;
    const clusterKey = String(row.cluster_key ?? '').trim();

    if (clusterKey) {
      if (usedCluster.has(clusterKey)) continue;
    }

    const currentTypeCount = typeCount.get(mt) ?? 0;
    if (currentTypeCount >= typeCap(mt)) continue;

    picked.push(row);

    if (clusterKey) usedCluster.add(clusterKey);
    typeCount.set(mt, currentTypeCount + 1);

    if (picked.length >= Math.max(1, maxItems)) break;
  }

  return picked;
}
