export function normalizeDiagnosisTargetKey(value: unknown): string | null {
  const raw = String(value ?? '').trim();

  if (!raw) return null;

  const normalized = raw
    .normalize('NFKC')
    .replace(/[\s　]+/g, '')
    .replace(/^(ir診断|診断|ir|IR)/iu, '')
    .replace(
      /(の診断結果|の診断内容|の診断|の結果|の件|との関係性|との関係|について|に関して|を深めて|を見て|をみて)$/u,
      '',
    )
    .replace(
      /(さん|様|先生|くん|君|ちゃん|氏)$/u,
      '',
    )
    .trim();

  return normalized.length > 0 ? normalized : null;
}
