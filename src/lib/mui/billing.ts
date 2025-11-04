import { PRICES, type ConversationStage } from './types';

// まずは完全停止（動作確認後に false へ）
export const BILLING_DISABLED = true as const;

export type BillOkFree = { ok: true; free: true; balance: null };
export type BillOkPaid = {
  ok: true;
  free?: false;
  chargeId: string | null;
  balance: number | null;
};
export type BillNg = { ok: false; error: string; status: number };

export async function chargeIfNeeded(opts: {
  userCode: string;
  stage?: ConversationStage | 'opening';
  payjpToken?: string;
  meta?: Record<string, any>;
}): Promise<BillOkFree | BillOkPaid | BillNg> {
  const { userCode, stage, payjpToken, meta } = opts;

  if (BILLING_DISABLED || !stage || stage === 'opening' || stage === 1) {
    return { ok: true, free: true, balance: null };
  }

  const key = stage === 2 ? 'phase2' : stage === 3 ? 'phase3' : ('phase4' as keyof typeof PRICES);
  const amount = PRICES[key];

  if (!Number.isInteger(amount) || amount < 50 || amount > 9_999_999) {
    return { ok: false, error: 'invalid_amount_range', status: 400 };
  }
  if (!payjpToken) return { ok: false, error: 'payjpToken required', status: 400 };

  const { chargeOneTurn } = await import('./charge');
  const res: any = await chargeOneTurn({
    userCode,
    amount,
    token: payjpToken,
    description: `Mui ${String(key)}`,
    idempotencyKey: `${userCode}:${String(key)}:${Date.now()}`,
    meta,
  } as any);

  if (!res?.ok)
    return { ok: false, error: res?.error ?? 'charge_failed', status: res?.status ?? 402 };
  return { ok: true, chargeId: res.chargeId ?? null, balance: res.balance ?? null };
}
