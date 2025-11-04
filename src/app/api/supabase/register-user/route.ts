import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import payjp from 'payjp';

// ✅ Supabase初期化（supabaseKey に修正）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!, // ← Vercel の登録に合わせた環境変数名
);

// ✅ PAY.JP初期化
const payjpClient = payjp(process.env.PAYJP_SECRET_KEY!, {
  timeout: 8000,
});

export async function POST(req: NextRequest) {
  try {
    const { token, user_code } = await req.json();

    console.log('📩 register-card に送信された user_code:', user_code);

    if (!token || !user_code) {
      return NextResponse.json({ error: 'token と user_code は必須です' }, { status: 400 });
    }

    // Supabaseからユーザー取得
    const { data: userData, error: fetchError } = await supabase
      .from('users')
      .select('payjp_customer_id')
      .eq('user_code', user_code)
      .single();

    if (fetchError || !userData?.payjp_customer_id) {
      return NextResponse.json(
        { error: 'ユーザーまたはpayjp_customer_idが見つかりません' },
        { status: 404 },
      );
    }

    const customerId = userData.payjp_customer_id;

    // カード登録
    const cardRes = await payjpClient.customers.createCard(customerId, { token });

    console.log('✅ カード登録成功:', cardRes.id);

    return NextResponse.json({ success: true, cardId: cardRes.id });
  } catch (err) {
    console.error('❌ register-card エラー:', err);
    return NextResponse.json(
      { error: 'カード登録に失敗しました', detail: String(err) },
      { status: 500 },
    );
  }
}
