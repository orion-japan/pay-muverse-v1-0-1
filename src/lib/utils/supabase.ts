import { createClient } from "@supabase/supabase-js";

// Supabase クライアント初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ✅ Supabaseからユーザーを user_code で取得（前後の空白を除去）
export async function getUserByCode(user_code: string) {
  const cleanCode = user_code.trim(); // ← 重要: 空白除去で一致性を確保
  const { data, error } = await supabase
    .from("users")
    .select("*")
    .eq("user_code", cleanCode)
    .single();

  if (error) {
    console.error("🔴 Supabase getUserByCode エラー:", error.message);
    throw new Error("Supabaseユーザーの取得に失敗しました");
  }

  return data;
}

// ✅ sofia_credit と click_type を更新
export async function updateUserCreditAndType(
  user_code: string,
  credit: number,
  plan_type: string
) {
  const cleanCode = user_code.trim();
  const { error } = await supabase
    .from("users")
    .update({
      sofia_credit: credit,
      click_type: plan_type,
    })
    .eq("user_code", cleanCode);

  if (error) {
    console.error("🔴 Supabase updateUserCreditAndType エラー:", error.message);
    throw new Error("Supabaseクレジットとタイプの更新に失敗しました");
  }
}

// ✅ サブスクIDや支払日を Supabase に更新
export async function updateUserSubscriptionMeta(
  user_code: string,
  subscription_id: string,
  last_payment_date: string,
  next_payment_date: string
) {
  const cleanCode = user_code.trim();
  const { error } = await supabase
    .from("users")
    .update({
      payjp_subscription_id: subscription_id,
      last_payment_date,
      next_payment_date,
    })
    .eq("user_code", cleanCode);

  if (error) {
    console.error("🔴 Supabase サブスク情報更新エラー:", error.message);
    throw new Error("Supabase サブスクリプション情報の更新に失敗しました");
  }
}
