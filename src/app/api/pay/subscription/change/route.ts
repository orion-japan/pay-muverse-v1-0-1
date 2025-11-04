import { NextRequest, NextResponse } from 'next/server';

const PAYJP_SECRET = process.env.PAYJP_SECRET_KEY!;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { customerId, cardId, newPlanId } = await req.json();

    // 1) 顧客カードに対する3Dセキュア
    const tdsRes = await fetch('https://api.pay.jp/v1/customer_card_tds', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(PAYJP_SECRET + ':').toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        customer: customerId,
        card: cardId,
        // 必要に応じて、リダイレクトURL等のパラメータを追加
      }),
    });

    const tds = await tdsRes.json();
    if (!tdsRes.ok) {
      return NextResponse.json({ error: '3DS failed', detail: tds }, { status: 400 });
    }

    // tds.status が 'authenticated' 等であることを確認（実運用で値をログ確認）
    if (tds.status && tds.status !== 'authenticated') {
      return NextResponse.json({ error: `3DS status=${tds.status}` }, { status: 400 });
    }

    // 2) 3DS成功後に Subscription を更新（エンドポイントは運用の設計に合わせて）
    // ここでは概念的な例（実際は PAY.JP の /subscriptions/{id} などを UPDATE）
    // await fetch('https://api.pay.jp/v1/subscriptions/{id}', { ... })

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'error' }, { status: 500 });
  }
}
