import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  const token = req.headers.get('x-payjp-webhook-token');
  if (token !== process.env.PAYJP_WEBHOOK_SECRET) {
    return new NextResponse('Invalid signature', { status: 400 });
  }

  const payload = await req.json();
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  if (payload.type === 'subscription.created' || payload.type === 'subscription.updated') {
    const sub = payload.data.object;
    const customerId = sub.customer;

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('payjp_customer_id', customerId)
      .single();

    if (user) {
      await supabase
        .from('users')
        .update({
          click_type: 'premium',
          sofiacredit: 200,
          payjp_subscription_id: sub.id,
          last_payment_date: new Date().toISOString()
        })
        .eq('user_code', user.user_code);
    }
  }

  return NextResponse.json({ received: true });
}
