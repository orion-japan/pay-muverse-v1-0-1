// src/app/api/pay/account/register-card/route.ts

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Payjp from 'payjp';

// ✅ PAY.JP初期化
const payjp = Payjp(process.env.PAYJP_SECRET_KEY || '');

export async function POST(req: Request) {
  try {
    const { user_code, token } = await req.json();
    console.log('🟢 受信データ:', { user_code, token });

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
        { status: 500 },
      );
    }

    const email = userData.click_email;
    console.log('📨 メール取得成功:', email);

    // ✅ PAY.JP 顧客作成
    const customer = await payjp.customers.create({
      email,
      card: token,
    });

    console.log('✅ PAY.JP顧客作成成功:', customer.id);

    // ✅ Supabaseに顧客IDとカード登録済みを保存
    const { error: updateError } = await supabase
      .from('users')
      .update({
        payjp_customer_id: customer.id,
        card_registered: true,
      })
      .eq('user_code', user_code);

    if (updateError) {
      console.error('❌ Supabase更新エラー:', updateError.message);
      return NextResponse.json(
        { error: 'Supabase更新エラー', detail: updateError.message },
        { status: 500 },
      );
    }

    console.log('🟢 Supabase更新完了: payjp_customer_id 保存成功');

    return NextResponse.json({
      success: true,
      message: 'カード登録と顧客ID保存完了',
      customer_id: customer.id,
    });
  } catch (err: any) {
    console.error('⨯ カード登録処理エラー:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'カード登録に失敗しました',
        detail: String(err),
      },
      { status: 500 },
    );
  }
}
