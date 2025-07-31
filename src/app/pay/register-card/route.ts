// src/app/api/pay/register-card/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Payjp from 'payjp';
import { createClient } from '@supabase/supabase-js';

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!  // ✅ 書き込み用のServiceキー
);

export async function POST(req: NextRequest) {
  try {
    const { userCode, token } = await req.json();
    console.log('✅ カード登録API:', { userCode, token });

    // ✅ 1. PAY.JPで顧客を作成 & カード登録
    const customer = await payjp.customers.create({
      card: token,
      description: `Muverse user: ${userCode}`
    });

    console.log('✅ PAY.JP Customer作成:', customer.id);

    // ✅ 2. Supabase 更新
    const { error } = await supabase
      .from('users')
      .update({
        payjp_customer_id: customer.id,
        card_registered: true
      })
      .eq('user_code', userCode);

    if (error) throw error;

    return NextResponse.json({ success: true, customerId: customer.id });
  } catch (err: any) {
    console.error('❌ カード登録APIエラー:', err);
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
