import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userCode = searchParams.get('user');

  if (!userCode) {
    return NextResponse.json({ error: 'user parameter is required' }, { status: 400 });
  }

  try {
    // Supabaseからユーザー情報を取得
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('usercode, payjp_customer_id, plan_name, next_billing_date, subscription_status')
      .eq('usercode', userCode)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // PAY.JPのカード登録状況を確認
    let cardRegistered = false;
    if (user.payjp_customer_id) {
      const customer = await payjp.customers.retrieve(user.payjp_customer_id);
      cardRegistered = customer.default_card !== null;
    }

    return NextResponse.json({
      usercode: user.usercode,
      payjpCustomerId: user.payjp_customer_id,
      planName: user.plan_name,
      nextBillingDate: user.next_billing_date,
      subscriptionStatus: user.subscription_status,
      cardRegistered,
    });
  } catch (error) {
    console.error('Account status error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
