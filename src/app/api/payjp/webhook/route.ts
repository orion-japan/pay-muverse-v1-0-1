import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import Payjp from 'payjp';

const payjp = Payjp(process.env.PAYJP_SECRET_KEY!);

export async function POST(req: NextRequest) {
  const body = await req.text();
  const signature = req.headers.get('payjp-signature');

  try {
    const event = payjp.webhooks.constructEvent(body, signature!, process.env.PAYJP_WEBHOOK_SECRET!);

    if (event.type === 'subscription.updated') {
      const subscription = event.data as any; // ← 型が不明なので一旦 any にします
      console.log('[WEBHOOK] Subscription updated:', subscription.id);
      // TODO: Supabase更新処理をここに書く
    }

    return NextResponse.json({ received: true });
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err);
    return NextResponse.json({ error: 'Webhook Error' }, { status: 400 });
  }
}
