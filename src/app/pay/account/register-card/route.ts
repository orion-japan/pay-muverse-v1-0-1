// src/app/api/pay/account/register-card/route.ts

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Payjp from 'payjp';

// ✅ PAY.JP 初期化（タイムアウト付き）
const payjp = Payjp(process.env.PAYJP_SECRET_KEY || '', { timeout: 10000 });

export async function POST(req: Request) {
  console.log('🚀 [register-card] API 呼び出し START');
  try {
    const { user_code, token } = await req.json();
    console.log('📥 [register-card] 受信データ:', { user_code, token });

    // ✅ パラメータチェック
    if (!user_code || !token) {
      console.error('❌ [register-card] user_code or token が未定義');
      return NextResponse.json(
        { success: false, error: '引数が不正です' },
        { status: 400 }
      );
    }

    // ✅ Supabase からメールアドレス取得
    console.log('🔍 [register-card] Supabase からメール取得開始');
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('click_email')
      .eq('user_code', user_code)
      .single();

    if (userError || !userData?.click_email) {
      console.error('❌ [register-card] Supabase メール取得失敗:', userError);
      return NextResponse.json(
        { error: 'ユーザーのメールアドレス取得に失敗しました' },
        { status: 500 }
      );
    }

    const email = userData.click_email;
    console.log('✅ [register-card] メール取得成功:', email);

    // ✅ PAY.JP 顧客作成
    console.log('📤 [register-card] PAY.JP 顧客作成開始');
    const customer = await payjp.customers.create({
      email,
      card: token,
      description: `Muverse user: ${user_code}`,
    });
    console.log('✅ [register-card] PAY.JP 顧客作成成功:', customer.id);

    // ✅ Supabase に顧客IDとカード登録済みを保存
    console.log('📤 [register-card] Supabase 更新開始');
    const { error: updateError } = await supabase
      .from('users')
      .update({
        payjp_customer_id: customer.id,
        card_registered: true,
      })
      .eq('user_code', user_code);

    if (updateError) {
      console.error('❌ [register-card] Supabase 更新失敗:', updateError.message);
      return NextResponse.json(
        { error: 'Supabase更新エラー', detail: updateError.message },
        { status: 500 }
      );
    }

    console.log('✅ [register-card] Supabase 更新完了: payjp_customer_id 保存成功');
    console.log('🎉 [register-card] API 完了');

    return NextResponse.json({
      success: true,
      message: 'カード登録と顧客ID保存完了',
      customer_id: customer.id,
    });
  } catch (err: any) {
    console.error('💥 [register-card] API エラー:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'カード登録に失敗しました',
        detail: String(err),
      },
      { status: 500 }
    );
  }
}
