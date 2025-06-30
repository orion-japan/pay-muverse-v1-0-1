// src/app/api/register/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '../../../../lib/supabase';

export async function POST(req: NextRequest) {
  try {
    const { ip, code, phoneNumber } = await req.json();

    // IP二重登録チェック
    const { data: ipExists } = await supabase
      .from('ip_histories')
      .select('*')
      .eq('ip_address', ip);

    if (ipExists && ipExists.length > 0) {
      return NextResponse.json({ error: 'IP already registered' }, { status: 400 });
    }

    // IP履歴テーブルに追加
    await supabase.from('ip_histories').insert({ ip_address: ip });

    // 紹介コード履歴テーブルに追加
    if (code) {
      await supabase.from('referral_codes').insert({
        code,
        registered_ip: ip,
      });
    }

    // ✅ Click API にリアルタイム送信
    const clickRes = await fetch(process.env.CLICK_API_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.CLICK_API_KEY!,
      },
      body: JSON.stringify({
        data: {
          ip_address: ip,
          code: code,
          phoneNumber: phoneNumber,
        },
      }),
    });

    // ✅ ステータスとContent-Typeを確認してからパース
    let clickResponse;

    if (clickRes.headers.get('content-type')?.includes('application/json')) {
      clickResponse = await clickRes.json();
    } else {
      clickResponse = await clickRes.text(); // HTMLエラーなど
    }

    console.log('Click API Response:', clickResponse);

    // ✅ Supabase に登録ログを保存
    await supabase.from('register_logs').insert({
      ip_address: ip,
      phone_number: phoneNumber,
      referral_code: code,
      click_response: clickResponse,
      created_at: new Date().toISOString(),
    });

    return NextResponse.json({ result: 'success' });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
