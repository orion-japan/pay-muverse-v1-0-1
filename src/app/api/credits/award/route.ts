// /src/app/api/credits/award/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { user_code, action = "daily", base = 45, reason = null } = body ?? {};
    if (!user_code) {
      return NextResponse.json({ ok: false, error: "missing: user_code" }, { status: 400 });
    }

    // 1) 今のプロモでいくつ配るか計算
    const { data, error } = await supabaseAdmin
      .rpc("compute_credit_for_action", { p_action: action, p_base_amount: base, p_user_code: user_code });
    if (error) throw new Error(error.message);
    const row = Array.isArray(data) ? data[0] : data;
    const amount = row.amount as number;
    const expires_at = row.expires_at as string | null;
    const promo_id = row.promo_id as string | null;

    // 2) 台帳へロット記録（+）
    const { error: e2 } = await supabaseAdmin.from("credit_ledger").insert({
      user_code,
      delta: amount,
      action,
      reason: reason ?? (promo_id ? `promo:${promo_id}` : action),
      promo_id,
      expires_at,
    });
    if (e2) throw new Error(e2.message);

    return NextResponse.json({ ok: true, granted: amount, expires_at, promo_id });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "unknown error" }, { status: 500 });
  }
}
