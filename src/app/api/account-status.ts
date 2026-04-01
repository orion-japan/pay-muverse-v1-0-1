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
    // =========================
    // ① usersテーブル（正本）を取得
    // =========================
    const { data: user, error: userError } = await supabase
      .from('users')
      .select(`
        user_code,
        payjp_customer_id,
        click_type,
        plan_status,
        sofia_credit,
        next_payment_date
      `)
      .eq('user_code', userCode)
      .single();

    if (userError || !user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // =========================
    // ② カード登録確認
    // =========================
    let cardRegistered = false;
    if (user.payjp_customer_id) {
      const customer = await payjp.customers.retrieve(user.payjp_customer_id);
      cardRegistered = customer.default_card !== null;
    }

    // =========================
    // ③ 期限切れ判定
    // =========================
    const now = new Date();
    const next = user.next_payment_date ? new Date(user.next_payment_date) : null;

    let planStatus = user.plan_status;
    let clickType = user.click_type;
    let credit = Number(user.sofia_credit ?? 0);

    // 👉 期限切れなら強制free
    if (next && next < now) {
      planStatus = 'free';
      clickType = 'free';
      credit = 0;
    }

    // =========================
    // ④ 返却
    // =========================
    return NextResponse.json({
      userCode: user.user_code,
      payjpCustomerId: user.payjp_customer_id,
      planStatus,
      clickType,
      nextPaymentDate: user.next_payment_date,
      sofiaCredit: credit,
      cardRegistered,
    });
  } catch (error) {
    console.error('Account status error:', error);
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
