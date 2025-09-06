// src/lib/mu/credits.ts
// 環境変数互換レイヤー：新旧どちらのENVでも同じ数値を返す

function num(v: string | undefined, fallback: number) {
  const n = v != null ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 互換ENV（どちらか設定されていれば優先）:
 * - テキスト: MU_CREDIT_PER_TURN / MU_CHAT_CREDIT_COST
 * - 画像   : MU_IMAGE_CREDIT / MU_IMAGE_CREDIT_COST
 */
export const MuCredits = {
  textPerTurn: num(
    process.env.MU_CREDIT_PER_TURN ?? process.env.MU_CHAT_CREDIT_COST,
    0.5
  ),
  imagePerGen: num(
    process.env.MU_IMAGE_CREDIT ?? process.env.MU_IMAGE_CREDIT_COST,
    3
  ),
} as const;

/** 参照用ヘルパ */
export function getMuTextCredit(): number {
  return MuCredits.textPerTurn;
}
export function getMuImageCredit(): number {
  return MuCredits.imagePerGen;
}
