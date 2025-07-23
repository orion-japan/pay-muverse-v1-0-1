import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import dayjs from "dayjs";
import Payjp from "payjp";
import { PLAN_ID_MAP } from "@/lib/constants/planIdMap";
import {
  getUserByCode,
  updateUserCreditAndType,
  updateUserSubscriptionMeta,
} from "@/lib/utils/supabase";

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);
const safe = (value: any) => (value === undefined || value === null ? "" : value);

export async function POST(req: NextRequest) {
  const logTrail: string[] = [];

  try {
    const body = await req.json();
    const {
      user_code,
      user_email,
      plan_type,
      customer_id,
      charge_amount,
      sofia_credit,
    } = body;

    logTrail.push(`📥 受信Payload: ${JSON.stringify(body, null, 2)}`);

    if (!user_code || !user_email || !plan_type || !customer_id) {
      throw new Error("必要なパラメータが不足しています");
    }

    const plan_price_id = PLAN_ID_MAP[plan_type];
    if (!plan_price_id || typeof plan_price_id !== "string") {
      throw new Error(`無効なプランタイプ: ${plan_type} → plan_idが取得できません`);
    }

    logTrail.push(`📦 PLAN_ID_MAP[${plan_type}] = ${plan_price_id}`);

    const user = await getUserByCode(user_code);
    if (!user) throw new Error("Supabase ユーザーが見つかりません");
    logTrail.push(`✅ Supabaseユーザー取得: ${user.user_code}`);

    const payjpPayload = {
      customer: customer_id,
      plan: plan_price_id,
    };
    logTrail.push(`➡️ PAY.JP送信: ${JSON.stringify(payjpPayload)}`);

    let subscription;
    try {
      subscription = await payjp.subscriptions.create(payjpPayload);
    } catch (err: any) {
      logTrail.push(`🔥 PAY.JPエラー: ${err?.message}`);

      if (err?.response) {
        try {
          const text = await err.response.text();
          logTrail.push(`📜 PAY.JP response.text: ${text}`);
        } catch {}
        try {
          const json = await err.response.json();
          logTrail.push(`📜 PAY.JP response.json: ${JSON.stringify(json)}`);
        } catch {}
        logTrail.push(`📜 PAY.JP status: ${err.response.status} / ${err.response.statusText}`);
      }

      return NextResponse.json(
        {
          success: false,
          error: "サブスク登録に失敗しました",
          detail: "PAY.JP サブスクリプション作成エラー",
          logTrail,
        },
        { status: 500 }
      );
    }

    const subscription_id = subscription.id;
    const last_payment_date = dayjs.unix(subscription.current_period_start).format("YYYY-MM-DD");
    const next_payment_date = dayjs.unix(subscription.current_period_end).format("YYYY-MM-DD");
    const payment_date = dayjs().format("YYYY-MM-DD");

    logTrail.push(`✅ サブスク登録成功: ${subscription_id}`);

    await updateUserSubscriptionMeta(
      user_code,
      subscription_id,
      last_payment_date,
      next_payment_date
    );
    logTrail.push("✅ Supabaseサブスク情報更新完了");

    await updateUserCreditAndType(user_code, sofia_credit, plan_type);
    logTrail.push("✅ Supabaseクレジット更新完了");

    // 🔐 Google Sheets 認証（Base64から読み込み）
    const base64Encoded = process.env.GOOGLE_SERVICE_ACCOUNT_BASE64!;
    if (!base64Encoded) throw new Error("GOOGLE_SERVICE_ACCOUNT_BASE64 が設定されていません");

    let credentials;
    try {
      const decoded = Buffer.from(base64Encoded, "base64").toString("utf-8");
      credentials = JSON.parse(decoded);
    } catch (err) {
      throw new Error("GOOGLE_SERVICE_ACCOUNT_BASE64 のデコードまたはパースに失敗しました");
    }

    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const authClient = await auth.getClient();
    const sheets = google.sheets({
      version: "v4",
      auth: authClient as any,
    });

    const row = [
      safe(user_code),
      safe(user_email),
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

    logTrail.push("📤 Google Sheets への書き込み開始");

    try {
      const writeResult = await sheets.spreadsheets.values.append({
        spreadsheetId: process.env.GOOGLE_SHEET_ID!,
        range: "sheet2", // ← 🔧 ここを修正！（以前は "sheet2!A1" だった）
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS", // ← 推奨（自動で次の行に追記される）
        requestBody: { values: [row] },
      });
      

      logTrail.push(`✅ Google Sheets 書込成功: ${JSON.stringify(writeResult.data, null, 2)}`);
    } catch (sheetError: any) {
      logTrail.push(`❌ Google Sheets 書込失敗: ${sheetError.message}`);
      return NextResponse.json(
        {
          success: false,
          error: "Google Sheets への書き込みに失敗しました",
          detail: sheetError.message,
          logTrail,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      subscription_id,
      logTrail,
    });
  } catch (error: any) {
    logTrail.push(`⛔ 例外発生: ${error.message}`);
    return NextResponse.json(
      {
        success: false,
        error: "内部エラーが発生しました",
        detail: error.message,
        logTrail,
      },
      { status: 500 }
    );
  }
}
