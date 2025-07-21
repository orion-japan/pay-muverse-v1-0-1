import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import payjp from 'payjp';
import { JWT } from 'google-auth-library';
import { google } from 'googleapis';

// Supabase 初期化：Vercel の環境変数と一致させる
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!  // ← 修正ポイント
);

// PAY.JP 初期化
const payjpClient = payjp(process.env.PAYJP_SECRET_KEY!, {
  timeout: 8000,
});

// Google Sheets 設定
const spreadsheetId = process.env.GOOGLE_SHEETS_ID!;
const sheetName = 'TEST_USER_001';

export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === 'true';
  const { plan, user_code } = await req.json();

  console.log('✅ [INPUT] user_code:', user_code);
  console.log('✅ [INPUT] plan:', plan);

  let sheetLogged = false;

  try {
    // ユーザー情報取得
    const { data: userData, error } = await supabase
      .from('users')
      .select('click_email, payjp_customer_id, payjp_subscription_id, sofia_credit')
      .eq('user_code', user_code)
      .single();

    if (error || !userData) {
      throw new Error('Supabaseユーザー取得エラー');
    }
    console.log('✅ Supabase ユーザー取得成功:', userData);

    // クレジット残がある場合の警告
    if (!force && userData.sofia_credit > 0) {
      const message = `⚠️ 現在のクレジット残：${userData.sofia_credit} 回\nこのまま購入すると ${plan.credit} 回に上書きされます。`;
      console.warn('⚠️ 警告返却:', message);
      return NextResponse.json({ warning: message });
    }

    // 既存サブスクリプションのキャンセル
    if (userData.payjp_subscription_id) {
      try {
        await payjpClient.subscriptions.cancel(userData.payjp_subscription_id);
        console.log('✅ 既存サブスクキャンセル成功:', userData.payjp_subscription_id);
      } catch (cancelError) {
        console.warn('⚠️ サブスクキャンセル失敗（続行）:', cancelError);
      }
    }

    // 新しいサブスクリプション作成
    const subscription = await payjpClient.subscriptions.create({
      customer: userData.payjp_customer_id,
      plan: plan.price_id,
    });
    console.log('✅ サブスク作成:', subscription.id);

    // Supabase のユーザーデータ更新
    const { error: updateError } = await supabase
      .from('users')
      .update({
        payjp_subscription_id: subscription.id,
        sofia_credit: plan.credit,
      })
      .eq('user_code', user_code);

    if (updateError) {
      throw new Error('Supabase更新失敗: ' + JSON.stringify(updateError));
    }
    console.log('✅ Supabase更新成功');

    // Google Sheets にログ書き込み
    try {
      const auth = new JWT({
        email: process.env.GOOGLE_CLIENT_EMAIL!,
        key: process.env.GOOGLE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
      const sheets = google.sheets({ version: 'v4', auth });

      const row = [
        user_code,
        userData.click_email,
        plan.plan_type,
        plan.price_id,
        subscription.id,
        userData.payjp_customer_id,
        plan.price,
        plan.credit,
        subscription.status,
        new Date().toISOString().slice(0, 10),
        'Web決済',
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [row] },
      });

      sheetLogged = true;
      console.log('✅ Sheets書き込み成功');
    } catch (sheetErr) {
      console.warn('⚠️ Sheets書き込み失敗（続行）:', sheetErr);
    }

    return NextResponse.json({
      success: true,
      sheetLogged,
      subscriptionId: subscription.id,
    });

  } catch (err: any) {
    let errorDetail = '';
    if (err?.response?.json) {
      try {
        const json = await err.response.json();
        errorDetail = JSON.stringify(json);
      } catch (e) {
        errorDetail = '[JSON取得失敗]';
      }
    }

    console.error('⨯ サブスク登録エラー:', errorDetail || err);
    return NextResponse.json(
      {
        error: 'サブスク登録に失敗しました',
        detail: errorDetail || String(err),
        success: false,
        sheetLogged,
      },
      { status: 500 }
    );
  }
}
