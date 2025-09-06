// src/lib/applyQ.ts
// 旧実装の fetchQUnified / decideQInfluence には依存しない。
// 新実装（./qcodes の buildSystemPrompt）に完全委譲する薄いラッパ。

import { buildSystemPrompt as buildFromQ } from './qcodes';

/**
 * Backward-compatible wrapper.
 * 既存の呼び出し側（buildSystemPrompt(base, userCode, { factual })）を壊さず、
 * ./qcodes の本実装へ委譲します。
 * - Q統合の取得
 * - 影響度の判定（current/hint/none）
 * - 監査記録（allowed 値: current/hint/none）
 * - Systemプロンプト合成（事実系は影響0、ガード付与）
 */
export async function buildSystemPrompt(
  base: string,
  userCode?: string,
  opts?: { factual?: boolean }
) {
  return buildFromQ(base, userCode ?? '', opts ?? {});
}
