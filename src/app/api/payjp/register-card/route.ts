import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';

export const runtime = 'nodejs';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ← Service Role 必須
);

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // フロントのキー揺れを吸収（構造は維持）
    let customer = body.customer ?? body.customer_id ?? null;
    const token = body.token ?? body.cardToken;
    const usercode = body.usercode ?? body.user_code ?? body.userCode;

    if (!token || !usercode) {
      return new NextResponse('Missing token or usercode', { status: 400 });
    }

    // Supabase: ユーザー取得
    const { data: user, error: userErr } = await supabase
      .from('users')
      .select('user_code, email, name, payjp_customer_id, card_registered')
      .eq('user_code', usercode)
      .single();

    if (userErr || !user) {
      return new NextResponse('User not found in Supabase', { status: 404 });
    }

    // 顧客IDが無ければ DBの値を使う→無ければ新規作成→DB保存
    if (!customer) {
      if (user.payjp_customer_id) {
        customer = user.payjp_customer_id;
      } else {
        const created = await payjp.customers.create({
          email: user.email ?? undefined,
          description: `muverse: ${user.user_code}`,
          metadata: { user_code: user.user_code },
        });
        customer = created.id;

        const { error: saveCusErr } = await supabase
          .from('users')
          .update({ payjp_customer_id: customer })
          .eq('user_code', user.user_code);

        if (saveCusErr) {
          return new NextResponse('Failed to save customer id', { status: 500 });
        }
      }
    }

    // PAY.JP: 顧客にカード追加
    const card = await payjp.customers.createCard(String(customer), { card: String(token) });

    // Supabase: カード登録フラグ true（冪等OK）
    const { error: updateErr } = await supabase
      .from('users')
      .update({
        card_registered: true,
        payjp_customer_id: String(customer),
      })
      .eq('user_code', user.user_code);

    if (updateErr) {
      return new NextResponse('Failed to update Supabase', { status: 500 });
    }

    // 反映確認を返却（フロントのNetworkで確認しやすく）
    const { data: after } = await supabase
      .from('users')
      .select('user_code, payjp_customer_id, card_registered')
      .eq('user_code', user.user_code)
      .single();

    return NextResponse.json({
      success: true,
      customer_id: String(customer),
      card: {
        id: card.id,
        brand: card.brand,
        last4: card.last4,
        exp_month: card.exp_month,
        exp_year: card.exp_year,
      },
      user_after: after,
    });
  } catch (err: any) {
    const isCardErr = /card|invalid|security code|insufficient/i.test(err?.message || '');
    return new NextResponse(
      isCardErr ? 'Payment Error' : 'Internal Server Error',
      { status: isCardErr ? 402 : 500 }
    );
  }
}
