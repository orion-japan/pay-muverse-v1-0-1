// /src/app/api/supabase/register-user/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// ✅ Supabase 初期化
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const { usercode, payjpCustomerId } = await req.json();

    console.log('📨 register-user に送信された usercode:', usercode);
    console.log('📨 register-user に送信された payjpCustomerId:', payjpCustomerId);

    if (!usercode || !payjpCustomerId) {
      console.warn('⚠️ 必須情報が欠落しています');
      return NextResponse.json(
        { error: 'usercodeとpayjpCustomerIdは必須です' },
        { status: 400 }
      );
    }

    // ✅ Supabaseへpayjp_customer_idを登録
    const { data, error } = await supabase
      .from('users')
      .update({
        payjp_customer_id: payjpCustomerId,
      })
      .eq('user_code', usercode)
      .select(); // ← 応答として data を返すために select を追加

    if (error || !data) {
      console.error('❌ Supabase登録エラー:', error);
      return NextResponse.json({ error: 'Supabase登録失敗' }, { status: 500 });
    }

    console.log('✅ Supabaseにpayjp_customer_idを保存しました');
    return NextResponse.json({ message: '登録成功', data });

  } catch (err) {
    console.error('🔥 想定外エラー:', err);
    return NextResponse.json({ error: '内部エラーが発生しました' }, { status: 500 });
  }
}
