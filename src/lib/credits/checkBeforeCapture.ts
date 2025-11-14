// file: src/lib/credit/checkBeforeCapture.ts
import type { SupabaseClient } from '@supabase/supabase-js';

export class InsufficientCreditError extends Error {
  payload: {
    ok: false;
    error: 'insufficient_credit';
    credit: { balance: number; required: number };
  };
  constructor(balance: number, required: number) {
    super('insufficient_credit');
    this.name = 'InsufficientCreditError';
    this.payload = {
      ok: false,
      error: 'insufficient_credit',
      credit: { balance, required },
    };
  }
}

type CheckResult = {
  ok: boolean;
  current_balance: number;
  required_amount: number;
};

/**
 * capture実行前の残高チェック。
 * OKなら { ok:true, balance } を返す。
 * 不足なら InsufficientCreditError を throw（HTTP 402にマッピング想定）。
 */
export async function ensureSufficientCredit(
  sb: SupabaseClient,
  userCode: string,
  amount: number, // 例: 5
): Promise<{ ok: true; balance: number }> {
  const { data, error } = await sb.rpc('check_user_balance_before_capture', {
    p_user_code: userCode,
    p_amount: amount,
  });

  if (error) {
    // 上位で 500 にマッピング
    throw new Error(`rpc_error: ${error.message}`);
  }

  const row = (Array.isArray(data) ? data[0] : data) as CheckResult | undefined;
  if (!row) {
    throw new Error('rpc_no_result');
  }

  const balance = Number(row.current_balance ?? 0);
  const required = Number(row.required_amount ?? amount);

  if (!row.ok) {
    throw new InsufficientCreditError(balance, required);
  }

  return { ok: true as const, balance };
}
