// src/app/api/pay/account/register-card/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Payjp from 'payjp';
import { createClient } from '@supabase/supabase-js';

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY! // ✅ Service Role Key
);

export async function POST(req: NextRequest) {
  try {
    const { user_code, token } = await req.json();
    console.log('✅ register-card API start', { user_code, token });

    if (!user_code || !token) {
      console.error('❌ Missing params', { user_code, token });
      return NextResponse.json({ success: false, error: '引数が不正です' }, { status: 400 });
    }

    // ✅ PAY.JP 顧客を作成
    const customer = await payjp.customers.create({
      card: token,
      description: `Muverse user: ${user_code}`
    });
    console.log('✅ PAY.JP Customer created:', customer.id);

    // ✅ Supabase に保存
    const { error } = await supabase
      .from('users')
      .update({
        payjp_customer_id: customer.id,
        card_registered: true
      })
      .eq('user_code', user_code);

    if (error) {
      console.error('❌ Supabase update failed', error.message);
      return NextResponse.json({ success: false, error: 'DB更新に失敗' }, { status: 500 });
    }

    console.log('✅ register-card API complete');
    return NextResponse.json({ success: true, customerId: customer.id });
  } catch (err: any) {
    console.error('❌ register-card API error', err);
    return NextResponse.json({ success: false, error: err.message || 'サーバーエラー' }, { status: 500 });
  }
}
