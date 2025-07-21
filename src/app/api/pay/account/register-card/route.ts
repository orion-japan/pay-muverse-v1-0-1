// src/app/api/pay/account/register-card/route.ts

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Payjp from 'payjp';

// ✅ PAY.JP初期化
const payjp = Payjp(process.env.PAYJP_SECRET_KEY || '');

export async function POST(req: Request) {
  try {
    const { user_code, token } = await req.json();

    // ✅ Supabaseからメールアドレス取得
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('click_email')
      .eq('user_code', user_code)
      .single();

    if (userError || !userData?.click_email) {
      console.error('❌ Supabaseからメール取得失敗:', userError);
      return NextResponse.json(
        { error: 'ユーザーのメールアドレス取得に失敗しました' },
        { status: 500 }
      );
    }

    const email = userData.click_email;

    // ✅ PAY.JP 顧客作成
    const customer = await payjp.customers.create({
      email,
      card: token,
    });

    // ✅ Supabaseに顧客IDとカード登録済みを保存
    const { error: updateError } = await supabase
      .from('users')
      .update({ payjp_customer_id: customer.id, card_registered: true })
      .eq('user_code', user_code);

    if (updateError) {
      console.error('❌ Supabase更新エラー:', updateError);
      return NextResponse.json(
        { error: updateError.message },
        { status: 500 }
      );
    }

    console.log('✅ カード登録完了:', customer.id);

    return NextResponse.json({
      message: 'Card registered',
      customer_id: customer.id,
    });
  } catch (err: any) {
    console.error('⨯ カード登録処理エラー:', err);
    return NextResponse.json(
      { error: 'カード登録に失敗しました', detail: String(err) },
      { status: 500 }
    );
  }
}
