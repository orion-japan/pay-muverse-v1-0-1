import { NextRequest, NextResponse } from "next/server";
import { google } from "googleapis";
import dayjs from "dayjs";
import Payjp from "payjp";
import {
  getUserByCode,
  updateUserCreditAndType,
  updateUserSubscriptionMeta,
} from "@/lib/utils/supabase";

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const logTrail: string[] = [];

  try {
    const body = await req.json();
    const {
      user_code,
      user_email,
      plan_type,
      plan_price_id,
      customer_id,
      charge_amount,
      sofia_credit,
    } = body;

    logTrail.push(`🟦 受信ペイロード: ${JSON.stringify(body, null, 2)}`);

    if (!user_code || !user_email || !plan_type || !plan_price_id || !customer_id) {
      throw new Error("必須パラメータが不足しています");
    }

    const payment_date = dayjs().format("YYYY-MM-DD");
    const memo = "Web決済";

    const user = await getUserByCode(user_code);
    if (!user) {
      throw new Error("Supabase ユーザーが見つかりません");
    }
    logTrail.push(`🟢 Supabaseユーザー取得成功: ${user.user_code}`);

    const payjpPayload = {
      customer: customer_id,
      plan: plan_price_id,
    };

    logTrail.push(`🧾 PAY.JP リクエスト内容: ${JSON.stringify(payjpPayload)}`);

    let subscription;
    try {
      subscription = await payjp.subscriptions.create(payjpPayload);
    } catch (err: any) {
      logTrail.push(`🔥 サブスク登録エラー: ${err?.message || String(err)}`);

      if (err?.response) {
        try {
          const text = await err.response.text?.();
          logTrail.push(`🟥 PAY.JP レスポンス(text): ${text}`);
        } catch {
          logTrail.push(`⚠️ PAY.JP response.text() 取得に失敗`);
        }

        try {
          const json = await err.response.json?.();
          logTrail.push(`🟥 PAY.JP レスポンス(json): ${JSON.stringify(json)}`);
        } catch {
          logTrail.push(`⚠️ PAY.JP response.json() 取得に失敗`);
        }

        logTrail.push(`📛 PAY.JP ステータス: ${err.response.status} / ${err.response.statusText}`);
      }

      return NextResponse.json({
        success: false,
        error: "サブスク登録に失敗しました",
        detail: "PAY.JP サブスクリプション作成エラー",
        logTrail,
      }, { status: 500 });
    }

    if (!subscription?.id) {
      throw new Error("PAY.JP サブスクリプション作成に失敗しました");
    }

    const subscription_id = subscription.id;
    const last_payment_date = dayjs.unix(subscription.current_period_start).format("YYYY-MM-DD");
    const next_payment_date = dayjs.unix(subscription.current_period_end).format("YYYY-MM-DD");

    logTrail.push(`🟢 PAY.JPサブスクリプション作成成功: ${subscription_id}`);

    await updateUserSubscriptionMeta(user_code, subscription_id, last_payment_date, next_payment_date);
    logTrail.push(`🟢 Supabaseサブスク情報を更新: ${subscription_id}`);

    await updateUserCreditAndType(user_code, sofia_credit, plan_type);
    logTrail.push(`🟢 Supabase credit/type を更新: ${sofia_credit} / ${plan_type}`);

    // 🔐 認証情報を環境変数から読み込む（JSON文字列 → オブジェクト）
    const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON!);

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });

    const sheets = google.sheets({ version: "v4", auth });

    const row = [
      user_code,
      user_email,
      plan_type,
      typeof charge_amount === "number" ? charge_amount : 0,
      typeof sofia_credit === "number" ? sofia_credit : 0,
      customer_id,
      last_payment_date,
      next_payment_date,
      user.card_registered ?? "",
      payment_date,
      memo,
      subscription_id,
      plan_price_id,
    ];

    const sheetId = process.env.GOOGLE_SHEET_ID!;
    if (!sheetId) throw new Error("GOOGLE_SHEET_ID が未設定です");

    const writeResult = await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "sheet2!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [row] },
    });

    logTrail.push(`🟢 Sheets書込完了`);

    return NextResponse.json({
      success: true,
      result: writeResult.data,
      subscription_id,
      logTrail,
    });
  } catch (error: any) {
    logTrail.push(`⛔ エラー: ${error.message}`);
    return NextResponse.json({
      success: false,
      error: "サブスク登録に失敗しました",
      detail: error.message,
      logTrail,
    }, { status: 500 });
  }
}
