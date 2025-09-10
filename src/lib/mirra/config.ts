// src/lib/mirra/config.ts
export const MIRRA_MODEL = process.env.MIRRA_MODEL || 'gpt-4o-mini';
export const MIRRA_TEMPERATURE = Number(process.env.MIRRA_TEMPERATURE ?? 0.4);
export const MIRRA_MAX_TOKENS = Number(process.env.MIRRA_MAX_TOKENS ?? 600);

// 粗めの料金（$ / token）。必要に応じて上書きしてください
export const MIRRA_PRICE_IN  = Number(process.env.MIRRA_PRICE_IN  ?? 0.15) / 1_000_000;
export const MIRRA_PRICE_OUT = Number(process.env.MIRRA_PRICE_OUT ?? 0.60) / 1_000_000;
