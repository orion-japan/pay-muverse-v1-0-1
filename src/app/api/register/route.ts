import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const data = await req.json();

    const {
      nickname,
      email,
      password,
      phone_number,
      ref,
      click_type,
      '#user_code': userCode,
      '#Rcode': inviteCode,
      Mcode,
      free_count,
      DATE
    } = data;

    // ✅ ClickのWebhookエンドポイント
    const CLICK_WEBHOOK_URL = process.env.CLICK_WEBHOOK_URL;

    // ✅ Clickに送るペイロード
    const payload = {
      click_username: nickname,
      click_email: email,
      Password: password, // 本番はハッシュ化推奨
      Tcode: phone_number,
      ref: ref,
      click_type: click_type,
      '#user_code': userCode,
      '#Rcode': inviteCode,
      Mcode: Mcode,
      free_count: free_count,
      DATE: DATE
    };

    const res = await fetch(CLICK_WEBHOOK_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error('Click送信エラー:', res.status, errorText);
      return NextResponse.json({ error: errorText }, { status: res.status });
    }

    console.log('Click送信成功:', await res.json());

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error('サーバー処理エラー:', e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
