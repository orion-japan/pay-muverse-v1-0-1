export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import dayjs from "dayjs";
import Payjp from "payjp";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { adminAuth } from "@/lib/firebase-admin";
import { PLAN_ID_MAP } from "@/lib/constants/planIdMap";

/* ========= ENV ========= */
function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

[
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYJP_SECRET_KEY",
  "GOOGLE_SERVICE_ACCOUNT_BASE64",
  "GOOGLE_SHEET_ID"
].forEach(mustEnv);

/* ========= Clients ========= */
const sb = createClient(
  mustEnv("NEXT_PUBLIC_SUPABASE_URL"),
  mustEnv("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } }
);

const payjp = Payjp(mustEnv("PAYJP_SECRET_KEY"));

/* ========= Helpers ========= */
const safe = (v: any) => (v === undefined || v === null ? "" : v);

function normalizePayjpError(err: any) {
  const n: Record<string, any> = {
    message: err?.message ?? null,
    type: err?.type ?? null,
    code: err?.code ?? null,
    status: err?.status ?? err?.response?.status ?? null,
    statusText: err?.response?.statusText ?? null,
  };
  try {
    if (err?.response?.body) n.body = err.response.body;
  } catch {}
  return n;
}

/* ========= Handler ========= */
export async function POST(req: NextRequest) {
  const logTrail: string[] = [];
  const log = (s: string) => logTrail.push(s);

  try {
    // 1) Firebase ID Token 検証
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!idToken) {
      log("❌ missing Authorization: Bearer <idToken>");
      return NextResponse.json(
        { success: false, error: "missing_id_token", logTrail },
        { status: 401 }
      );
    }

    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(idToken, true);
    } catch (e) {
      log(`❌ invalid_id_token: ${String((e as any)?.message || e)}`);
      return NextResponse.json(
        { success: false, error: "invalid_id_token", logTrail },
        { status: 401 }
      );
    }

    const firebase_uid: string | null = decoded?.uid ?? null;
    const emailFromToken: string | null = decoded?.email ?? null;
    log(`✅ token verified: uid=${firebase_uid}, email=${emailFromToken}`);

    // 2) Body 受取
    const body = (await req.json().catch(() => ({}))) as any;
    const {
      plan_type,
      customer_id,
      charge_amount,
      sofia_credit,
      tdsr_id,                 // ← 3DS 完了後の 2 回目 POST ではこれが来る
      charge_id,               // ★ 追加：3DS完了後、charge_idでも最終化できるように受ける
      user_email,
      user_code: user_code_from_body,
      force_cancel_existing
    } = body ?? {};

    log(`📥 payload: ${JSON.stringify(body)}`);

    const missing: string[] = [];
    if (!plan_type) missing.push("plan_type");
    if (!customer_id) missing.push("customer_id");
    if (!firebase_uid) missing.push("firebase_uid(token)");
    if (missing.length) {
      log(`⚠ missing: ${missing.join(",")}`);
      return NextResponse.json(
        { success: false, error: "必要なパラメータが不足しています", missing, logTrail },
        { status: 400 }
      );
    }

    const plan_price_id = PLAN_ID_MAP[plan_type];
    if (!plan_price_id || typeof plan_price_id !== "string") {
      log(`❌ invalid plan_type: ${plan_type}`);
      return NextResponse.json(
        { success: false, error: `無効なプラン: ${plan_type}`, logTrail },
        { status: 400 }
      );
    }
    log(`📦 plan_id = ${plan_price_id}`);

    // 3) Supabase ユーザー解決
    let { data: user, error: userErr } = await sb
      .from("users")
      .select("*")
      .eq("firebase_uid", firebase_uid!)
      .single();

    if ((!user || userErr) && emailFromToken) {
      const retry = await sb.from("users").select("*").eq("click_email", emailFromToken).single();
      user = retry.data;
      userErr = retry.error;
      if (user && (!user.firebase_uid || user.firebase_uid !== firebase_uid)) {
        await sb.from("users").update({ firebase_uid }).eq("user_code", user.user_code);
        log("🔁 uid synced to users.firebase_uid");
      }
    }

    if (userErr || !user) {
      log(`❌ Supabase user not found: ${userErr?.message || "no row"}`);
      return NextResponse.json(
        { success: false, error: "ユーザーが見つかりません", logTrail },
        { status: 404 }
      );
    }

    const user_code = user.user_code as string;
    log(`✅ user loaded: ${user_code}`);

    /* ===========================================================
       A) 2回目（3DS 完了後）: tdsr_id もしくは charge_id でサブスク作成へ
       =========================================================== */
    if (tdsr_id || charge_id) {
      log(`🔁 finalize after 3DS: tdsr_id=${tdsr_id ?? "-"}, charge_id=${charge_id ?? "-"}`);

      // （任意）3DSリクエストや与信の状態を確認してログに残すだけ
      try {
        if (tdsr_id) {
          // @ts-ignore
          const tdsr = await (payjp as any).tdsRequests?.retrieve?.(tdsr_id);
          log(`ℹ️ tds_request: ${tdsr ? JSON.stringify(tdsr) : "n/a"}`);
        } else if (charge_id) {
          const ch = await payjp.charges.retrieve(String(charge_id));
          log(`ℹ️ charge.status=${ch?.status}, three_d_secure_status=${(ch as any)?.three_d_secure_status ?? "n/a"}`);
        }
      } catch (e:any) {
        log(`⚠ status check failed: ${e?.message || e}`);
      }

      // 既存サブスクのキャンセル
      if (force_cancel_existing && user.payjp_subscription_id) {
        try {
          log(`🪓 cancel existing subscription: ${user.payjp_subscription_id}`);
          await payjp.subscriptions.cancel(user.payjp_subscription_id);
          await sb.from("users").update({
            payjp_subscription_id: null,
            last_payment_date: null,
            next_payment_date: null,
          }).eq("user_code", user_code);
          log("✅ existing subscription canceled");
        } catch (e: any) {
          log(`⚠ cancel existing failed: ${e?.message}`);
        }
      }

      // サブスク作成
      let subscription: any;
      try {
        subscription = await payjp.subscriptions.create({ customer: String(customer_id), plan: String(plan_price_id) });
      } catch (err: any) {
        const nerr = normalizePayjpError(err);
        log(`🔥 PAY.JP error (subscriptions.create): ${JSON.stringify(nerr)}`);
        return NextResponse.json(
          {
            success: false,
            error: "サブスク登録に失敗しました",
            detail: "PAY.JP サブスクリプション作成エラー",
            payjp: nerr,
            logTrail,
          },
          { status: 500 }
        );
      }

      const currentStart = Number(subscription?.current_period_start ?? 0);
      const currentEnd = Number(subscription?.current_period_end ?? 0);
      const last_payment_date = currentStart > 0 ? dayjs.unix(currentStart).format("YYYY-MM-DD") : dayjs().format("YYYY-MM-DD");
      const next_payment_date = currentEnd > 0 ? dayjs.unix(currentEnd).format("YYYY-MM-DD") : dayjs().add(1, "month").format("YYYY-MM-DD");
      const payment_date = dayjs().format("YYYY-MM-DD");
      const subscription_id = String(subscription.id);

      log(`✅ subscription created: ${subscription_id}`);

      // DB 更新
      const isAdmin = user.user_role === "admin";
      const updatePayload: Record<string, any> = {
        payjp_subscription_id: subscription_id,
        last_payment_date,
        next_payment_date,
      };
      if (!isAdmin) {
        updatePayload.sofia_credit = typeof sofia_credit === "number" ? sofia_credit : user.sofia_credit ?? 0;
        updatePayload.click_type = plan_type;
        updatePayload.plan_status = plan_type;
      }

      const { data: updated, error: upErr } = await sb
        .from("users")
        .update(updatePayload)
        .eq("user_code", user_code)
        .select("user_code")
        .maybeSingle();

      if (upErr || !updated) {
        log(`🔴 DB update error: ${upErr?.message || "0 rows updated"}`);
        return NextResponse.json(
          { success: false, error: "サブスクリプション情報の更新に失敗しました", logTrail },
          { status: 500 }
        );
      }

      log("✅ DB: subscription meta (and plan) updated");

      // Sheets 追記
      let sheets: any;
      try {
        const decoded = Buffer.from(mustEnv("GOOGLE_SERVICE_ACCOUNT_BASE64"), "base64").toString("utf-8");
        const credentials = JSON.parse(decoded);

        const auth = new google.auth.GoogleAuth({
          credentials,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
        const authClient = await auth.getClient();
        sheets = google.sheets({ version: "v4", auth: authClient as any });
      } catch (err: any) {
        log(`❌ GoogleAuth init failed: ${err?.message ?? err}`);
        return NextResponse.json(
          { success: false, error: "Google 認証初期化に失敗しました", logTrail },
          { status: 500 }
        );
      }

      const row = [
        safe(user_code),
        safe(user_email || emailFromToken),
        safe(plan_type),
        typeof charge_amount === "number" ? charge_amount : 0,
        typeof sofia_credit === "number" ? sofia_credit : 0,
        safe(customer_id),
        safe(last_payment_date),
        safe(next_payment_date),
        safe(user.card_registered),
        safe(payment_date),
        "Web決済",
        safe(subscription_id),
        safe(plan_price_id),
      ];

      log("📤 Sheets append start");
      try {
        await sheets.spreadsheets.values.append({
          spreadsheetId: mustEnv("GOOGLE_SHEET_ID"),
          range: "Sheet1!A1",
          valueInputOption: "USER_ENTERED",
          insertDataOption: "INSERT_ROWS",
          requestBody: { values: [row] },
        });
        log("✅ Sheets append succeeded");
        return NextResponse.json({ success: true, logTrail });
      } catch (sheetError: any) {
        log(`❌ Sheets write failed: ${sheetError?.message}`);
        if (sheetError?.response?.data) {
          log(`📄 Sheets resp: ${JSON.stringify(sheetError.response.data)}`);
        }
        return NextResponse.json(
          {
            success: false,
            error: "Google Sheets への書き込みに失敗しました",
            detail: sheetError?.message,
            logTrail,
          },
          { status: 500 }
        );
      }
    }

    /* ===========================================================
       B) 1回目：3DS 要否判定のためのダミー与信 → 3DS 開始
       =========================================================== */
    const probeAmount = typeof charge_amount === "number" && charge_amount > 0 ? charge_amount : 100;
    log(`💳 create probe charge: amount=${probeAmount}`);

    let charge: any;
    try {
      charge = await payjp.charges.create({
        amount: probeAmount,
        currency: "jpy",
        customer: String(customer_id),
        capture: false,
        description: `3DS probe for ${plan_type} by ${user_code}`,
      });
      log(`✅ charge created: ${charge?.id}`);
    } catch (err:any) {
      const nerr = normalizePayjpError(err);
      log(`🔥 PAY.JP error (charges.create): ${JSON.stringify(nerr)}`);
      return NextResponse.json(
        {
          success: false,
          error: "与信の作成に失敗しました",
          detail: "PAY.JP charges.create でエラー",
          payjp: nerr,
          logTrail,
        },
        { status: 500 }
      );
    }

    // 3DS リクエスト作成（作れなくても charge_id は返す）
    let tdsr_id_created: string | null = null;
    try {
      // @ts-ignore
      const tdsReq = await (payjp as any).tdsRequests?.create?.({ charge: charge.id });
      if (tdsReq?.id) {
        tdsr_id_created = tdsReq.id as string;
        log(`✅ tds_request created: ${tdsr_id_created}`);
      } else {
        log("⚠ tdsRequests.create returned no id");
      }
    } catch (e:any) {
      log(`⚠ tdsRequests.create failed: ${e?.message || e}`);
    }

    // ★ 修正: URL ドメイン&パス（/v1なし）
    const confirmation_url = `https://pay.jp/tds/start?resource=charge&id=${charge.id}`;

    // ★ 追加: charge_id を返却（フロントで openThreeDSecureDialog に使う）
    return NextResponse.json({
      success: false,
      confirmation_required: true,
      confirmation_url,
      tdsr_id: tdsr_id_created,
      charge_id: charge.id,   // ← これを返す
      logTrail,
    });

  } catch (error: any) {
    const msg = error?.message ?? String(error);
    log(`⛔ unhandled: ${msg}`);
    if (error?.response?.data) log(`📄 resp: ${JSON.stringify(error.response.data)}`);
    return NextResponse.json(
      {
        success: false,
        error: "内部エラーが発生しました",
        detail: msg,
        logTrail,
      },
      { status: 500 }
    );
  }
}
