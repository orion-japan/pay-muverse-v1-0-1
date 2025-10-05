// src/lib/mui/charge.ts
export type ChargeOk  = { ok: true;  balance: number | null };
export type ChargeErr = { ok: false; status?: number; error: string };
export type ChargeResult = ChargeOk | ChargeErr;

export type ChargeInput = {
  userCode: string;
  amount: number;
  meta?: Record<string, any>;
};

export async function chargeOneTurn(input: ChargeInput): Promise<ChargeResult> {
  try {
    if (!input?.userCode) return { ok: false, status: 400, error: 'userCode required' };
    if (!Number.isFinite(input?.amount)) return { ok: false, status: 400, error: 'amount required' };
    return { ok: true, balance: null };
  } catch (e: any) {
    return { ok: false, status: 500, error: String(e?.message ?? e) };
  }
}

/** ユーザー定義型ガード：エラー側に絞り込む */
export const isChargeErr = (r: ChargeResult): r is ChargeErr => r.ok === false;
