// src/app/api/pay/account/register-card/route.ts

import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import Payjp from 'payjp';

const payjp = Payjp(process.env.PAYJP_SECRET_KEY || '');

export async function POST(req: Request) {
  const { user_code, token } = await req.json();

  const customer = await payjp.customers.create({
    email: `${user_code}@muverse.jp`,
    card: token,
  });

  const { error } = await supabase
    .from('users')
    .update({ payjp_customer_id: customer.id, card_registered: true })
    .eq('user_code', user_code);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ message: 'Card registered', customer_id: customer.id });
}
