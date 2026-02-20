// src/lib/mu/credits.ts
import { createClient } from '@supabase/supabase-js';

/** ========= 型 ========= */
export type MuCredits = {
  text: number; // テキスト系1往復の基準消費
  image: number; // 画像1枚の基準消費（sizeやモデルで増減）
  balance?: number; // 残高（任意）
};

export type SpendInput = {
  user_code: string; // 必須
  amount: number; // 消費するクレジット（正の数）
  reason?: string; // 例: "image.generate" / "chat"
  meta?: Record<string, any> | null;
};

export type SpendResult = {
  ok: boolean;
  balance: number; // 消費後残高。取得できなければ -1
  tx_id: string; // 台帳トランザクションID相当
  error?: string | null;
};

/** ========= 環境値 ========= */
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// 環境に合わせて変更可：台帳テーブル / 残高ビュー
const LEDGER_TABLE = process.env.CREDIT_LEDGER_TABLE || 'credit_ledger';
const BALANCE_VIEW = process.env.CREDIT_BALANCE_VIEW || 'credit_balance_view';

/** ========= コスト計算（最小実装） =========
 * モデルやサイズごとにクレジットの“目安”を返す。
 * 必要に応じて実コストへ差し替えてください。
 */

// テキスト：モデル別の簡易係数
export function getMuTextCredit(model?: string): number {
  const m = (model || '').toLowerCase();

  // 例: 軽量モデルは1、標準〜高性能は2〜3 など
  if (m.includes('mini')) return 1;
  if (m.includes('gpt-5')) return 2;
  if (m.includes('gpt-5')) return 2;
  // 不明ならデフォルト1
  return 1;
}

// 画像：サイズ/モデル別の簡易係数
export function getMuImageCredit(size?: string, model?: string): number {
  const s = (size || '1024x1024').toLowerCase();
  let base = s === '256x256' ? 1 : s === '512x512' ? 2 : /* 1024x1024 他 */ 4;

  const m = (model || '').toLowerCase();
  // 高機能モデルなら係数UP（必要に応じ調整）
  if (m.includes('xl') || m.includes('hd')) base += 1;

  return base;
}

/** ========= 消費実行 =========
 * 名前付きエクスポート：reserveAndSpendCredit
 * - Supabase 環境が未設定のときは NOOP 成功（開発ビルドを止めない）
 * - まず台帳に delta を挿入（負数で消費）
 * - その後、残高ビューがあれば残高を取得
 */
export async function reserveAndSpendCredit(input: SpendInput): Promise<SpendResult> {
  const txId = (globalThis as any).crypto?.randomUUID?.()
    ? crypto.randomUUID()
    : `tx-${Date.now()}`;

  // 環境未設定なら NOOP 成功
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    console.warn('[credits] Missing Supabase env; NOOP success.');
    return { ok: true, balance: -1, tx_id: txId };
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 台帳へ消費レコードを挿入（最小実装）
    const row = {
      tx_id: txId,
      user_code: input.user_code,
      delta: -Math.abs(input.amount), // 消費は負数で記録
      reason: input.reason ?? 'spend',
      meta: input.meta ?? null,
      created_at: new Date().toISOString(),
    };

    const { error } = await supabase.from(LEDGER_TABLE).insert(row);
    if (error) {
      console.error('[credits] insert error:', error);
      return { ok: false, balance: -1, tx_id: txId, error: error.message };
    }

    // 残高取得（任意）
    let balance = -1;
    const { data: bal, error: balErr } = await supabase
      .from(BALANCE_VIEW)
      .select('balance')
      .eq('user_code', input.user_code)
      .maybeSingle();

    if (!balErr && bal?.balance !== undefined) {
      balance = Number(bal.balance);
    }

    return { ok: true, balance, tx_id: txId };
  } catch (e: any) {
    console.error('[credits] fatal:', e);
    return { ok: false, balance: -1, tx_id: txId, error: String(e?.message || e) };
  }
}

/** ========= 補助 ========= */
export function canAfford(balance: number, cost: number): boolean {
  if (balance < 0) return true; // 不明時は許可（運用に応じて変更）
  return balance >= cost;
}

/** ========= 既定のクレジット表（任意利用） ========= */
export const DEFAULT_MU_CREDITS: MuCredits = {
  text: 1,
  image: 4, // 1024x1024 を基準
};
