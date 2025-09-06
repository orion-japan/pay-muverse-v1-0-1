// src/lib/mu/credits.ts
import { createClient } from "@supabase/supabase-js";

export type SpendInput = {
  user_code: string;
  amount: number; // 消費するクレジット（正の数）
  reason?: string; // "image.generate" など
  meta?: Record<string, any>;
};

export type SpendResult = {
  ok: boolean;
  balance: number;     // 消費後残高（不明な場合は -1 で返す）
  tx_id: string;       // 台帳のトランザクションID相当
  error?: string | null;
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const LEDGER_TABLE = process.env.CREDIT_LEDGER_TABLE || "credit_ledger";

/**
 * 最小実装：
 * - Supabase 環境が揃っていれば台帳に挿入を試みる
 * - 環境が無ければ NOOP で成功扱い（ビルド＆開発を止めない）
 */
export async function reserveAndSpendCredit(input: SpendInput): Promise<SpendResult> {
  const txId = globalThis.crypto?.randomUUID?.() ? crypto.randomUUID() : `${Date.now()}`;

  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.warn("[credits] Missing Supabase env. NOOP success.");
    return { ok: true, balance: -1, tx_id: `dev-${txId}` };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 最小の台帳挿入（負の増減で記録）
    const row = {
      tx_id: txId,
      user_code: input.user_code,
      delta: -Math.abs(input.amount),
      reason: input.reason ?? "spend",
      meta: input.meta ?? null,
    };

    const { error } = await supabase.from(LEDGER_TABLE).insert(row);
    if (error) {
      console.error("[credits] insert error:", error);
      return { ok: false, balance: -1, tx_id: txId, error: error.message };
    }

    // 残高取得は任意（無ければ -1）
    let balance = -1;
    const BALANCE_VIEW = process.env.CREDIT_BALANCE_VIEW || "credit_balance_view";
    const { data: bal } = await supabase
      .from(BALANCE_VIEW)
      .select("balance")
      .eq("user_code", input.user_code)
      .maybeSingle();

    if (bal?.balance !== undefined) balance = bal.balance as number;

    return { ok: true, balance, tx_id: txId };
  } catch (e: any) {
    console.error("[credits] fatal:", e);
    return { ok: false, balance: -1, tx_id: txId, error: String(e?.message || e) };
  }
}
