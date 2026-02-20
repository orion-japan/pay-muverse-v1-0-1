// renderGateway.rephrasePolicy.ts

export type RephraseForceInput = {
  isIR: boolean;
  isSilence: boolean;
  rephraseBlocksLen: number;
  hasBlocks: boolean;
  extra: any;
};

export function shouldForceRephraseBlocks(input: RephraseForceInput): boolean {
  const {
    isIR,
    isSilence,
    rephraseBlocksLen,
    hasBlocks,
    extra,
  } = input;

  if (isIR) return false;
  if (isSilence) return false;
  if (rephraseBlocksLen <= 0) return false;
  if (hasBlocks) return false;

  // 🔐 明示的フラグのみ許可
  const explicit =
    extra?.blockPlan?.explicitTrigger === true ||
    extra?.forceRephrase === true ||
    extra?.explicitRephrase === true;

  return explicit === true;
}
