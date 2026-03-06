// src/lib/iros/memory/longTermMemory.cluster.ts
// iros — Long Term Memory semantic cluster v1
// 目的：表現ゆれのある長期メモリーを「意味クラスタ」に寄せる

import type { LongTermMemoryType } from './longTermMemory.types';

export type LongTermMemoryClusterMatch = {
  clusterKey: string | null;
  canonicalValueText: string | null;
};

type ClusterRule = {
  memoryType: LongTermMemoryType;
  clusterKey: string;
  canonicalValueText: string;
  patterns: RegExp[];
};

const CLUSTER_RULES: ClusterRule[] = [
  {
    memoryType: 'working_rule',
    clusterKey: 'working_rule/code_one_by_one',
    canonicalValueText: 'コードは1つずつ提示してください',
    patterns: [
      /コードは1つずつ/,
      /コードを1つずつ/,
      /コードは一つずつ/,
      /コードを一つずつ/,
      /1つずつ提示/,
      /一つずつ提示/,
      /一括で出さない/,
      /まとめて出さない/,
    ],
  },
  {
    memoryType: 'working_rule',
    clusterKey: 'working_rule/no_speculative_fix',
    canonicalValueText: '憶測で修正しないでください',
    patterns: [
      /憶測で修正しない/,
      /推測で修正しない/,
      /見当で進めない/,
      /憶測は禁止/,
      /未確認で修正しない/,
    ],
  },
  {
    memoryType: 'working_rule',
    clusterKey: 'working_rule/verify_before_fix',
    canonicalValueText: '修正前に必ず確認してください',
    patterns: [
      /修正前に必ず確認/,
      /確認してから修正/,
      /先に確認/,
      /コードまたはsqlで確認/,
      /必ずコードまたはsqlで行う/,
    ],
  },
];

function normalizeForCluster(text: string): string {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[。、．,.!！?？]/g, '')
    .replace(/\s+/g, '');
}

export function matchLongTermMemoryClusterV1(args: {
  memoryType: LongTermMemoryType;
  valueText: string;
}): LongTermMemoryClusterMatch {
  const memoryType = args.memoryType;
  const valueText = String(args.valueText ?? '').trim();
  const normalized = normalizeForCluster(valueText);

  if (!normalized) {
    return {
      clusterKey: null,
      canonicalValueText: null,
    };
  }

  for (const rule of CLUSTER_RULES) {
    if (rule.memoryType !== memoryType) continue;
    if (rule.patterns.some((re) => re.test(normalized))) {
      return {
        clusterKey: rule.clusterKey,
        canonicalValueText: rule.canonicalValueText,
      };
    }
  }

  return {
    clusterKey: null,
    canonicalValueText: null,
  };
}
