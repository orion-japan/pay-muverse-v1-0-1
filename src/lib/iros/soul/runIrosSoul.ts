// src/lib/iros/soul/runIrosSoul.ts
// Soul failsafe runner
// - shouldUseSoul() が true の時だけ動く（= 3軸欠損/不整合のみ）
// - LLM は呼ばない（prompt.ts は経由しない）
// - composeSoulReply() の最小文だけ返す

import type { IrosSoulInput } from './types';
import { shouldUseSoul } from './shouldUseSoul';
import { composeSoulReply } from './composeSoulReply';

export type RunIrosSoulResult = {
  used: boolean;
  soulText: string | null;
  soulNote: null; // failsafe では SoulNote を生成しない（混入経路を断つ）
};

export async function runIrosSoul(input: IrosSoulInput): Promise<RunIrosSoulResult> {
  const useSoul = shouldUseSoul(input);

  if (!useSoul) {
    return { used: false, soulText: null, soulNote: null };
  }

  const soulText = composeSoulReply({
    userText: input.userText,
    qCode: input.qCode,
    depthStage: input.depthStage,
    styleHint: (input as any).styleHint ?? null, // 無ければ null（互換）
    soulNote: null,
  });

  return { used: true, soulText, soulNote: null };
}

// 既存コードが default import している可能性に備えた互換
export default runIrosSoul;
