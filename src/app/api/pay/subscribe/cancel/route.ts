import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { payjp } from '@/lib/payjp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { user_code } = await req.json();
    if (!user_code) return NextResponse.json({ error: 'user_code required' }, { status: 400 });

    const { data: u, error } = await supabaseAdmin
      .from('users')
      .select('user_code, payjp_subscription_id')
      .eq('user_code', user_code)
      .maybeSingle();
    if (error) throw error;
    if (!u) return NextResponse.json({ error: 'user not found' }, { status: 404 });

    if (u.payjp_subscription_id) {
      await payjp(`/subscriptions/${u.payjp_subscription_id}`, { method: 'DELETE' });
    }

    // フロント表示用に即時 free 落とし（最終確定はWebhookでも流れてくる）
    await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/pay/plan/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_code,
        new_click_type: 'free',
        reason: 'subscription.canceled(manual)',
        source: 'api',
        plan_valid_until: null,
        payjp_subscription_id: null,
      }),
    });

    return NextResponse.json({ success: true });
  } catch (e: any) {
    console.error('[subscribe/cancel] error', e);
    return NextResponse.json({ error: e?.message || 'error' }, { status: 500 });
  }
}
