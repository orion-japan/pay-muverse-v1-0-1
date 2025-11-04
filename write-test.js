import { google } from 'googleapis';
import { readFileSync } from 'fs';

// 1. サービスアカウントの JSON 読み込み
const auth = new google.auth.GoogleAuth({
  keyFile: './sofia-sheets-writer.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function writeToSheet() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const spreadsheetId = '1Z8UAqjRzTT8NyVVnN3twMlmyq8TzjzzcYzrfLepl890'; // ← あなたのスプレッドシートID
  const range = 'シート1!A1'; // ← 書き込み先の範囲

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: {
      values: [['Test Nickname', 'test@example.com', '+819012345678']],
    },
  });

  console.log('✅ Sheets Response:', response.data);
}

writeToSheet().catch(console.error);
