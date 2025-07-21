// /api/payjp/create-customer/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Payjp from 'payjp';
import { createClient } from '@supabase/supabase-js';

// ✅ Supabase初期化（環境変数名を supabaseKey に統一）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!
);

// ✅ PAY.JP初期化
const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    const { usercode } = await req.json();
    console.log('✅ create-customerに送信されたusercode:', usercode);

    if (!usercode) {
      console.error('❌ usercodeが未定義です');
      return NextResponse.json({ error: 'usercode is required' }, { status: 400 });
    }

    // 🔍 Supabaseからemailを取得
    const { data, error } = await supabase
      .from('users')
      .select('click_email')
      .eq('user_code', usercode)
      .single();

    if (error || !data?.click_email) {
      console.error('❌ Supabaseからemail取得失敗:', error);
      return NextResponse.json({ error: 'メールアドレスの取得に失敗しました' }, { status: 500 });
    }

    const email = data.click_email;
    console.log('📧 email:', email);

    // 🧾 PAY.JP 顧客作成
    const customer = await payjp.customers.create({
      email,
      description: `Customer for ${usercode}`,
    });

    console.log('🧾 PAY.JPで顧客作成成功:', customer);

    return NextResponse.json({ customer });
  } catch (error) {
    console.error('❌ PAY.JP create-customer エラー:', error);
    return NextResponse.json({ error: 'PAY.JP customer creation failed' }, { status: 500 });
  }
}
