import { NextRequest, NextResponse } from 'next/server';
import { google } from 'googleapis';
import { supabase } from '@/lib/supabase';
import path from 'path';
import { promises as fs } from 'fs';

// ✅ Rcode 生成：先頭大文字＋後ろ小文字
function generateRcode(prefix: string, length: number = 8): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  const formatted = result.charAt(0).toUpperCase() + result.slice(1);
  return `${prefix}-${formatted}`;
}

// ✅ user_code: U- + 8桁の大文字小文字数字ランダム生成
function generateUserCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 8; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `U-${result}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    console.log('✅ 受け取ったデータ:', body);
    console.log('🔗 REcode確認:', body.ref); // REcodeのデバッグログ
    console.log('🔗 REcode型:', typeof body.ref); // REcodeの型確認
    console.log('🔗 REcode長さ:', body.ref ? body.ref.length : 0); // REcodeの長さ確認

    // ✅ バリデーション
    if (!body.click_username || !body.click_email) {
      return NextResponse.json({ error: '必須項目が不足しています' }, { status: 400 });
    }

    // ✅ 重複チェック
    const { data: existingUsers, error: checkError } = await supabase
      .from('users')
      .select('click_email, Tcode')
      .or(`click_email.eq.${body.click_email},Tcode.eq.${body.Tcode}`);

    if (checkError) {
      console.error('❌ 重複チェックエラー:', checkError);
    } else if (existingUsers && existingUsers.length > 0) {
      const duplicateEmail = existingUsers.some(user => user.click_email === body.click_email);
      const duplicatePhone = existingUsers.some(user => user.Tcode === body.Tcode);
      
      let errorMessage = '';
      if (duplicateEmail && duplicatePhone) {
        errorMessage = 'メールアドレスと電話番号の両方が既に登録されています';
      } else if (duplicateEmail) {
        errorMessage = 'このメールアドレスは既に登録されています';
      } else if (duplicatePhone) {
        errorMessage = 'この電話番号は既に登録されています';
      }
      
      return NextResponse.json({ error: errorMessage }, { status: 409 });
    }

    // ✅ 固定値と生成値
    const user_code = generateUserCode();
    const Rcode = generateRcode('R');
    const click_type = 'free';
    const Mcode = '336699';
    const sofia_credit = 25;
    const DATE = new Date().toISOString();

        // ✅ Google Sheets 認証（JSONファイル使用）
    try {
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
      const spreadsheetId = process.env.GOOGLE_SHEETS_ID || '1Z8UAqjRzTT8NyVVnN3twMlmyq8TzjzzcYzrfLepl890';

    console.log('✅ spreadsheetId:', spreadsheetId);
    console.log('🔗 Sheets用REcode:', body.ref || ''); // Sheets用REcodeのデバッグログ

      // ✅ Sheets用データ
    const values = [
      [
          body.click_email || '',           // click_email
          '',                              // Password (空文字)
          body.click_username || '',        // click_username
          '',                              // FullName
          user_code,                       // user_code
          Rcode,                           // Rcode
          Mcode,                           // Mcode
          click_type,                      // click_type
          sofia_credit,                    // sofia_credit
          body.Tcode || '',                // Tcode
          DATE.split('T')[0],              // DATE (YYYY-MM-DD)
          body.ref || ''                   // REcode（紹介者のuser_code）
      ],
    ];

    console.log('🔗 Sheets用データ全体:', values[0]); // Sheets用データ全体のデバッグログ

    // ✅ Sheets に追記
    await sheets.spreadsheets.values.append({
      spreadsheetId,
        range: 'シート1!A:L', // A列〜L列
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values },
    });

    console.log('✅ Sheets 保存OK');
    } catch (sheetError) {
      console.error('❌ Sheets エラー:', sheetError);
      // Sheetsエラーでも処理を続行
    }

    // ✅ Supabase にデータを保存
    const { data: supabaseData, error: supabaseError } = await supabase
      .from('users')
      .insert([
        {
          id: user_code, // user_codeをidとして使用（文字列）
        click_email: body.click_email,
        Password: '', // 空文字
          click_username: body.click_username,
          FullName: '',
          user_code: user_code,
          Rcode: Rcode,
          Mcode: Mcode,
          REcode: body.ref || '', // 紹介者のuser_code
          click_type: click_type,
          sofia_credit: sofia_credit,
          Tcode: body.Tcode || '',
          DATE: DATE
        }
      ])
      .select();

    if (supabaseError) {
      console.error('❌ Supabase エラー:', supabaseError);
      return NextResponse.json({ status: 'error', message: 'Supabase保存に失敗しました' }, { status: 500 });
    }

    console.log('✅ Supabase 保存OK:', supabaseData);
    console.log('🔗 Supabase用REcode:', body.ref || ''); // Supabase用REcodeのデバッグログ
    console.log('🔗 Supabase保存データ:', {
      id: user_code,
      click_email: body.click_email,
      click_username: body.click_username,
      REcode: body.ref || '',
      Tcode: body.Tcode || ''
    }); // Supabase保存データのデバッグログ

    return NextResponse.json({ 
      status: 'success',
      user_code: user_code,
      Rcode: Rcode,
      REcode: body.ref || '' // レスポンスにもREcodeを含める
    });
  } catch (error) {
    console.error('❌ API Error:', error);
    return NextResponse.json({ status: 'error', message: String(error) });
  }
}
