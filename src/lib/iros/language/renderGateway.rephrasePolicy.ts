// renderGateway.rephrasePolicy.ts

export type RephraseForceInput = {
  isIR: boolean;
  isSilence: boolean;
  rephraseBlocksLen: number;
  hasBlocks: boolean;
  extra: any;
};

export function shouldForceRephraseBlocks(input: RephraseForceInput): boolean {
  const { isIR, isSilence, rephraseBlocksLen, hasBlocks, extra } = input;

  // IR/沈黙では絶対に強制しない
  if (isIR) return false;
  if (isSilence) return false;

  // rephraseBlocks が無いなら強制しない
  if (rephraseBlocksLen <= 0) return false;

  // 既に blocks があるなら強制しない（= forced は “blocks無い時の救済” 専用）
  if (hasBlocks) return false;

  // 🔐 明示的フラグのみ許可
  const explicit =
    extra?.blockPlan?.explicitTrigger === true ||
    extra?.forceRephrase === true ||
    extra?.explicitRephrase === true;

  return explicit === true;
}
