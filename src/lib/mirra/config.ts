export const MIRRA_MODEL = process.env.MIRRA_MODEL || 'gpt-4o';
export const MIRRA_TEMPERATURE = Number(process.env.MIRRA_TEMPERATURE ?? 0.7);
export const MIRRA_TOP_P = Number(process.env.MIRRA_TOP_P ?? 0.95);
export const MIRRA_FREQ_PENALTY = Number(process.env.MIRRA_FREQ_PENALTY ?? 0.6);
export const MIRRA_PRES_PENALTY = Number(process.env.MIRRA_PRES_PENALTY ?? 0.7);
export const MIRRA_MAX_TOKENS = Number(process.env.MIRRA_MAX_TOKENS ?? 900);

// クレジット（1往復 = 1.0）
export const MIRRA_CHAT_CREDIT_COST = Number(process.env.MIRRA_CHAT_CREDIT_COST ?? 1.0);

// 料金 ($/token → $/1M tokens に合わせて正規化)
export const MIRRA_PRICE_IN = Number(process.env.MIRRA_PRICE_IN ?? 2.5) / 1_000_000;
export const MIRRA_PRICE_OUT = Number(process.env.MIRRA_PRICE_OUT ?? 10.0) / 1_000_000;
