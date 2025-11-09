// src/lib/iros/memory/metrics.ts
import type { ResonanceMetrics } from './types';

const INNER_HINTS = ['迷い','内','怖','不安','揺ら','整理','静けさ','傷','痛み','反省','受容'];
const OUTER_HINTS = ['公開','発表','売上','提案','営業','連携','デプロイ','イベント','発信','顧客'];

const DEPTH_RULES: { depth: ResonanceMetrics['depth']; cues: string[] }[] = [
  { depth: 'S1', cues: ['自己','内観','呼吸','静けさ','受容'] },
  { depth: 'S2', cues: ['揺ら','不安','怖','葛藤'] },
  { depth: 'R1', cues: ['関係','チーム','調整','対話'] },
  { depth: 'C1', cues: ['設計','仕様','実装','タスク','デザイン'] },
  { depth: 'C2', cues: ['リリース','運用','KPI','課金'] },
  { depth: 'I1', cues: ['意図','目的','ビジョン'] },
  { depth: 'I2', cues: ['核','本質','真意'] },
  { depth: 'I3', cues: ['祈り','場を動かす','共鳴場'] },
];

export function inferMetrics(text: string): ResonanceMetrics {
  const t = (text || '').toLowerCase();

  const inner = INNER_HINTS.some(w => t.includes(w.toLowerCase()));
  const outer = OUTER_HINTS.some(w => t.includes(w.toLowerCase()));
  const phase = inner && !outer ? 'Inner' : (!inner && outer ? 'Outer' : (inner ? 'Inner' : 'Outer'));

  let depth: ResonanceMetrics['depth'] = phase === 'Inner' ? 'S2' : 'C1';
  for (const r of DEPTH_RULES) {
    if (r.cues.some(w => t.includes(w.toLowerCase()))) { depth = r.depth; break; }
  }

  const q_primary =
    t.includes('怒') ? 'Q2' :
    t.includes('不安') ? 'Q3' :
    t.includes('恐') ? 'Q4' :
    t.includes('空虚') || t.includes('情熱') ? 'Q5' :
    'Q3';

  return { phase, depth, q_primary };
}
