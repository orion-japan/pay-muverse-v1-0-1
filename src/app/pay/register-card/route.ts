// src/app/api/pay/register-card/route.ts
import { NextRequest, NextResponse } from 'next/server';
import Payjp from 'payjp';
import { createClient } from '@supabase/supabase-js';

// ✅ PAY.JP 初期化（秘密鍵はサーバーサイド専用）
const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

// ✅ Supabase 初期化
// 🚩 Serviceキーは「SUPABASE_SERVICE_ROLE_KEY」で統一（環境変数にもこれを設定）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,        // ← Public URL
  process.env.SUPABASE_SERVICE_ROLE_KEY!        // ← Service Role Key（必須）
);

export async function POST(req: NextRequest) {
  try {
    const { userCode, token } = await req.json();
    console.log('✅ カード登録API:', { userCode, token });

    // ✅ 1. PAY.JPで顧客作成 & カード登録
    const customer = await payjp.customers.create({
      card: token,
      description: `Muverse user: ${userCode}`
    });

    console.log('✅ PAY.JP Customer作成:', customer.id);

    // ✅ 2. Supabase の users テーブル更新
    const { error } = await supabase
      .from('users')
      .update({
        payjp_customer_id: customer.id,
        card_registered: true
      })
      .eq('user_code', userCode);

    if (error) throw error;

    return NextResponse.json({ success: true, customerId: customer.id });

  } catch (err: any) {
    console.error('❌ カード登録APIエラー:', err);
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
