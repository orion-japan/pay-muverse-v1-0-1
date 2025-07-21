import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// POSTエンドポイント
export async function POST(req: NextRequest) {
  // PAY.JP Webhookからの署名トークンを取得
  const token = req.headers.get('x-payjp-webhook-token');

  // トークンが一致しない場合は拒否
  if (token !== process.env.PAYJP_WEBHOOK_SECRET) {
    return new NextResponse('Invalid signature', { status: 400 });
  }

  // Webhookのペイロードをパース
  const payload = await req.json();

  // Supabaseクライアント（service_roleでフルアクセス）
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY! // 🔑 anonではなくservice_roleを使用
  );

  // 該当イベントの処理（subscription作成または更新）
  if (payload.type === 'subscription.created' || payload.type === 'subscription.updated') {
    const sub = payload.data.object;
    const customerId = sub.customer; // PAY.JPの顧客ID

    // 該当するユーザーを取得（payjp_customer_idが一致するレコード）
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('payjp_customer_id', customerId)
      .single();

    if (error) {
      console.error('ユーザー取得失敗:', error);
      return new NextResponse('User not found', { status: 404 });
    }

    if (user) {
      // 該当ユーザーを更新（プレミアム化・ソフィアクレジット加算）
      const { error: updateError } = await supabase
        .from('users')
        .update({
          click_type: 'premium',
          sofiacredit: 200,
          payjp_subscription_id: sub.id,
          last_payment_date: new Date().toISOString()
        })
        .eq('user_code', user.user_code);

      if (updateError) {
        console.error('ユーザー更新失敗:', updateError);
        return new NextResponse('Update failed', { status: 500 });
      }
    }
  }

  // Webhookを正常に受け取ったレスポンス
  return NextResponse.json({ received: true });
}
