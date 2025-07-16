import { NextRequest, NextResponse } from 'next/server';
import { getPayjp } from '@/lib/payjpClient';
import { supabase } from '@/lib/supabaseClient';

export async function POST(req: NextRequest) {
  const payjp = getPayjp();

  console.log('✅ PAYJP_SECRET_KEY:', process.env.PAYJP_SECRET_KEY);

  const { user_code, plan } = await req.json();

  console.log('✅ API受信 user_code:', user_code);
  console.log('✅ API受信 plan:', plan);

  // ユーザー取得
  const { data: user } = await supabase
    .from('users')
    .select('*')
    .eq('user_code', user_code)
    .single();

  console.log('✅ Supabaseから取得したuser:', user);

  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  // 顧客IDをトリムして安全化
  let customerId = user?.payjp_customer_id?.trim();

  // 既にサブスクが存在する場合は二重登録を防ぐ
  if (user.payjp_subscription_id) {
    console.log('✅ 既にサブスクリプションIDあり:', user.payjp_subscription_id);
    return NextResponse.json({
      message: '既にサブスクリプションが存在します',
      subscription_id: user.payjp_subscription_id,
      redirect: 'https://YOURDOMAIN/success'
    });
  }

  // 顧客が存在しない場合、新規作成
  if (!customerId) {
    const customer = await payjp.customers.create({
      email: user.click_email || 'default@example.com',
      metadata: { user_code },
    });

    customerId = customer.id;

    await supabase
      .from('users')
      .update({ payjp_customer_id: customerId })
      .eq('user_code', user_code);

    console.log('✅ PAY.JP customer created:', customerId);

    return NextResponse.json({
      error: 'カード未登録です。先にカード登録を行ってください。',
    }, { status: 400 });
  }

  // サブスク作成
  const subscription = await payjp.subscriptions.create({
    customer: customerId,
    plan: plan.price_id, // plan_xxx を渡す！
  });

  console.log('✅ PAY.JP subscription created:', subscription.id);

  // SupabaseにサブスクIDを保存
  await supabase
    .from('users')
    .update({ payjp_subscription_id: subscription.id })
    .eq('user_code', user_code);

  return NextResponse.json({
    message: 'Subscription created',
    subscription_id: subscription.id,
    redirect: 'https://YOURDOMAIN/success' // ← フロントでここを受け取る！
  });
}
