// src/lib/iros/memory/scorer.ts
import type { EvidenceCard, ResonanceMetrics } from './types';

/** もっとも単純な重み付け（語彙類似は外部で計算済み想定） */
export function rankEvidences(
  evidences: EvidenceCard[],
  metrics?: ResonanceMetrics
): EvidenceCard[] {
  const phaseBias = metrics?.phase === 'Inner' ? 0.05 : 0; // Innerなら +0.05
  return evidences
    .map((e) => {
      const trust = e.trust ?? 0.8;
      const recencyBoost = e.date ? recencyScore(e.date) : 0.0;
      const base = trust * 0.6 + recencyBoost * 0.35 + phaseBias;
      return { e, score: base };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

function recencyScore(iso: string) {
  const now = Date.now();
  const t = new Date(iso).getTime();
  const days = Math.max(1, (now - t) / (1000 * 60 * 60 * 24));
  // 新しいほど高スコア（30日以内で0.35→0へ減衰）
  return Math.max(0, 0.35 - (days / 30) * 0.35);
}
