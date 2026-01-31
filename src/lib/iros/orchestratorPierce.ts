// src/lib/iros/orchestratorPierce.ts
// I層 Piercing 判定 + SelfAcceptance による Priority 補正

import type { Depth } from './system';
import { deriveIrosPriority } from './will/priorityEngine';
import { classifySelfAcceptance } from './orchestratorMeaning';

// Priority 型（SA 補正用）
export type IrosPriority = ReturnType<typeof deriveIrosPriority>;

/* ========= I層 Piercing ヘルパー ========= */

export type PierceDecision = {
  pierceMode: boolean;
  pierceReason: string | null;
};

/**
 * ir / ir診断 / irで見てください / 意図診断 / 意図トリガー などの
 * テキスト起動ワードを検知する。
 */
export function detectIrTrigger(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // "iros", "Iros", "IROS" の場合は除外
  if (/^(iros|Iros|IROS)/i.test(trimmed)) {
    return false;
  }

  // 単独 "ir" 入力
  if (lower === 'ir') return true;

  // 行頭の "ir " / "ir　"
  if (/^ir[\s　]/i.test(trimmed)) return true;

  // 日本語の起動ワード
  if (
    trimmed.includes('ir診断') ||
    trimmed.includes('ir で見て') ||
    trimmed.includes('irで見て') ||
    trimmed.includes('意図診断') ||
    trimmed.includes('意図トリガー')
  ) {
    return true;
  }

  return false;
}

/**
 * I層で「刺す一行」を必須にするかどうかの判定。
 *
 * - ir 起動：無条件で ON（ir_trigger）
 * - Depth：R1 / R2 / C1 / I1 / I2 / I3
 *   かつ SelfAcceptance >= 0.6
 *   かつ Y の揺れレベルが高すぎないとき（≤ 2）
 */
export function decidePierceMode(params: {
  depth: Depth | null | undefined;
  requestedDepth?: Depth;
  selfAcceptance: number | null;
  yLevel: number | null;
  irTriggered: boolean;
}): PierceDecision {
  const { depth, requestedDepth, selfAcceptance, yLevel, irTriggered } = params;

  if (irTriggered) {
    return {
      pierceMode: true,
      pierceReason: 'ir_trigger',
    };
  }

  const depthWindow: Depth | null =
    depth ?? (requestedDepth ? requestedDepth : null);

  const inWindow =
    depthWindow === 'R1' ||
    depthWindow === 'R2' ||
    depthWindow === 'C1' ||
    depthWindow === 'I1' ||
    depthWindow === 'I2' ||
    depthWindow === 'I3';

  const saOk =
    selfAcceptance != null && !Number.isNaN(selfAcceptance)
      ? selfAcceptance >= 0.6
      : false;

  // Y: 0〜3 を想定。3 はかなり揺れている → 2以下なら「刺しても折れにくい」ゾーンとみなす
  const yOk =
    typeof yLevel === 'number' && !Number.isNaN(yLevel) ? yLevel <= 2 : true;

  if (inWindow && saOk && yOk) {
    return {
      pierceMode: true,
      pierceReason: 'depth_window',
    };
  }

  return {
    pierceMode: false,
    pierceReason: null,
  };
}

/* ========= Priority 補正（SelfAcceptance 反映） ========= */

export function adjustPriorityWithSelfAcceptance(
  priority: IrosPriority,
  selfAcceptance: number | null,
): IrosPriority {
  if (selfAcceptance == null || Number.isNaN(selfAcceptance)) {
    return priority;
  }

  const band = classifySelfAcceptance(selfAcceptance);

  const weights = priority.weights || {};
  let mirror = (weights as any).mirror ?? 0;
  let insight = (weights as any).insight ?? 0;
  let forward = (weights as any).forward ?? 0;
  const question = (weights as any).question ?? 0;

  // low：まず「鏡」と「理解」を厚く、forward は抑える
  if (band === 'low') {
    mirror *= 1.4;
    insight *= 1.2;
    forward *= 0.6;
  }
  // mid：デフォルトに少し鏡寄り
  else if (band === 'mid') {
    mirror *= 1.1;
    // forward はそのまま
  }
  // high：forward を強めて一歩を押す
  else if (band === 'high') {
    mirror *= 0.9;
    forward *= 1.3;
  }

  return {
    ...priority,
    weights: {
      mirror,
      insight,
      forward,
      question,
    },
  };
}
