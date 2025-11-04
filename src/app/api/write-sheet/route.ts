import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import path from 'path';
import { promises as fs } from 'fs';
import { adminAuth } from '@/lib/firebase-admin';

export async function POST(req: NextRequest) {
  try {
    // ✅ Firebase IDトークンの検証
    const authHeader = req.headers.get('authorization');
    const token = authHeader?.replace(/^Bearer\s+/i, '');

    if (!token) {
      return NextResponse.json({ error: '認証トークンがありません' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(token);
    const uid = decoded.uid;
    const email = decoded.email;
    const emailVerified = decoded.email_verified;

    if (!emailVerified) {
      return NextResponse.json({ error: 'メールアドレスが認証されていません' }, { status: 403 });
    }

    // ✅ リクエストボディの解析
    const body = await req.json();
    const values = body.values;

    if (!Array.isArray(values) || values.length === 0) {
      return NextResponse.json(
        { error: 'values配列が必要です' },
        {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        },
      );
    }

    // ✅ Google Sheets 認証
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(
        await fs.readFile(path.join(process.cwd(), './sofia-sheets-writer.json'), 'utf8'),
      ),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheetId = process.env.GOOGLE_SHEETS_ID;

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: 'sheet2!A:L',
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    return NextResponse.json(
      { message: '書き込み成功' },
      {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  } catch (error) {
    console.error('❌ Sheets APIエラー:', error);
    return NextResponse.json(
      { error: '書き込みエラー' },
      {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      },
    );
  }
}
