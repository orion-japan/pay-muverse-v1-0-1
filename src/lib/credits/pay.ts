// src/lib/credits/pay.ts
import { admin } from '@/lib/supabase/server';

const COST = Number(process.env.IROS_COST_PER_TURN ?? 5);

export function costPerTurn() {
  return COST;
}

export async function authorizeTurn(user_code: string, ref: string, amount = COST) {
  const { data, error } = await admin.rpc('credit_authorize', {
    p_user_code: user_code,
    p_amount: amount,
    p_ref: ref,
  });
  if (error) throw new Error(`authorize_failed: ${error.message}`);
  return data; // { ok: true, status: 'new' | 'exists' }
}

export async function captureTurn(user_code: string, ref: string, amount = COST) {
  const { data, error } = await admin.rpc('credit_capture', {
    p_user_code: user_code,
    p_amount: amount,
    p_ref: ref,
  });
  if (error) throw new Error(`capture_failed: ${error.message}`);
  return data; // { ok:true, status:'captured'|'already_captured', balance: ... }
}

export async function getBalance(user_code: string) {
  const { data, error } = await admin.rpc('credit_get_balance', { p_user_code: user_code });
  if (error) throw new Error(error.message);
  return Number(data ?? 0);
}
