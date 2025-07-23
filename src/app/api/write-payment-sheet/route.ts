// ✅ src/app/api/write-payment-sheet/route.ts（不要？）

import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import path from 'path';
import { promises as fs } from 'fs';

// POST: 決済後のデータを書き込む
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log('✅ 決済用Sheets書き込み受け取り:', body);

    // 必須項目チェック
    if (!body.user_code || !body.user_email || !body.plan_type || !body.charge_amount) {
      return NextResponse.json({ error: '必須項目が不足しています' }, { status: 400 });
    }

    // 日付（ISO → YYYY-MM-DD）
    const payment_date = new Date().toISOString().split('T')[0];

    // ✅ Google Sheets 認証
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(
        await fs.readFile(
          path.join(process.cwd(), './sofia-sheets-writer.json'),
          'utf8'
        )
      ),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId =
      process.env.GOOGLE_SHEETS_ID ||
      '1Z8UAqjRzTT8NyVVnN3twMlmyq8TzjzzcYzrfLepl890'; // ← 必要に応じて変更

    // ✅ 書き込む列（シート2）
    const values = [
      [
        payment_date,                 // 日付
        body.customer_id || '',       // 顧客ID
        body.user_code || '',         // user_code
        body.user_email || '',        // メール
        body.plan_type || '',         // 選択プラン
        body.charge_amount || '',     // 決済金額
        body.sofia_credit || '',      // sofia_credit
        body.webhook_id || '',        // Webhook IDなど（任意）
      ],
    ];

    console.log('✅ 決済用 Sheets values:', values);

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'sheet2!A:K',
 // ← シート2で8列
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    console.log('✅ 決済用 Sheets 書き込み成功');
    return NextResponse.json({ status: 'success' });
  } catch (error) {
    console.error('❌ 決済用 Sheets 書き込みエラー:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
