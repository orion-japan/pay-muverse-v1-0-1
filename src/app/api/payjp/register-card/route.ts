import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';

// ✅ Edge関数のタイムアウト回避
export const runtime = 'nodejs';

// ✅ Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!! // ← anonではなく service role を使用
);

// ✅ PAY.JP 初期化
const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { customer, token, usercode } = body;

    console.log('🧾 [API] 受信した顧客ID:', customer);
    console.log('💳 [API] 受信したカードトークン:', token);
    console.log('👤 [API] 対象ユーザーコード:', usercode);

    if (!customer || !token || !usercode) {
      console.error('❌ customer, token, または usercode が未定義です');
      return new NextResponse('Missing customer, token, or usercode', { status: 400 });
    }

    // ✅ PAY.JP: 顧客にカードを登録
    console.log('🚀 PAY.JP にカード登録リクエスト送信');
    const updateResult = await payjp.customers.update(customer, {
      card: token,
    });
    console.log('✅ [PAY.JP] カード登録成功:', updateResult.id);

    // ✅ Supabase: 対象ユーザーを usercode で検索
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('*')
      .eq('user_code', usercode)
      .single();

    if (userErr || !user) {
      console.error('❌ [Supabase] ユーザー取得失敗:', userErr);
      return new NextResponse('User not found in Supabase', { status: 404 });
    }

    // ✅ Supabase: カード登録フラグと顧客IDを保存
    const { error: updateErr } = await supabase
      .from('users')
      .update({
        card_registered: true,
        payjp_customer_id: customer,
      })
      .eq('user_code', user.user_code);

    if (updateErr) {
      console.error('❌ [Supabase] カード登録情報の更新失敗:', updateErr);
      return new NextResponse('Failed to update Supabase', { status: 500 });
    }

    console.log('🎉 [完了] Supabaseへの登録完了');
    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('🔥 [APIエラー]', err);
    return new NextResponse('Internal Server Error', { status: 500 });
  }
}
