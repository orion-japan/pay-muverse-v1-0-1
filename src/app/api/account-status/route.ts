// src/app/api/account-status/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

type UserData = {
  user_code: string;
  click_type: string;
  card_registered: boolean;
  payjp_customer_id: string | null;
  sofia_credit: number | null;
  click_email: string | null;
};

// ✅ POST（firebase_uid から取得）
export async function POST(req: NextRequest) {
  const { firebase_uid } = await req.json();

  if (!firebase_uid) {
    return NextResponse.json({ error: 'No firebase_uid provided' }, { status: 400 });
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
    .eq('firebase_uid', firebase_uid)
    .single();

  if (error || !data) {
    console.error('❌ Supabase error (POST):', error);
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({
    user_code: data.user_code,
    click_type: data.click_type,
    card_registered: data.card_registered === true,
    payjp_customer_id: data.payjp_customer_id ?? null,
    sofia_credit: data.sofia_credit ?? 0,
    click_email: data.click_email ?? '',
  });
}

// ✅ GET（user_code から取得）
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user');

  if (!user_code) {
    return NextResponse.json({ error: 'No user_code provided' }, { status: 400 });
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
    .eq('user_code', user_code)
    .single();

  if (error || !data) {
    console.error('❌ Supabase error (GET):', error);
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  return NextResponse.json({
    user_code: data.user_code,
    click_type: data.click_type,
    card_registered: data.card_registered === true,
    payjp_customer_id: data.payjp_customer_id ?? null,
    sofia_credit: data.sofia_credit ?? 0,
    click_email: data.click_email ?? '',
  });
}
