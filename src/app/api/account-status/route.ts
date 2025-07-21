// src/app/api/account-status/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type UserData = {
  user_code: string;
  click_type: string;
  card_registered: boolean;
  payjp_customer_id: string | null;
  sofia_credit: number | null;
  click_email: string | null; // ← 追加
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const userCode = searchParams.get('user')?.trim();

  if (!userCode) {
    return NextResponse.json({ error: 'No usercode' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('users')
    .select(`
      user_code,
      click_type,
      card_registered,
      payjp_customer_id,
      sofia_credit,
      click_email
    `)
    .eq('user_code', userCode)
    .single<UserData>();

  if (error || !data) {
    console.error('❌ Supabase error:', error);
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({
    user_code: data.user_code,
    click_type: data.click_type,
    card_registered: data.card_registered === true,
    payjp_customer_id: data.payjp_customer_id ?? null,
    sofia_credit: data.sofia_credit ?? 0,
    click_email: data.click_email ?? '', // ✅ ← 追加
  });
}
