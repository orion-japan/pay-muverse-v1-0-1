import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { payjp, form } from '@/lib/payjp';
import { mapClickToPlan } from '@/lib/planMap';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PLAN_IDS: Record<string, string | undefined> = {
  pro: process.env.PAYJP_PLAN_PRO_ID,
  master: process.env.PAYJP_PLAN_MASTER_ID,
};

async function getUser(user_code: string) {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('user_code, click_type, plan_status, payjp_customer_id, payjp_subscription_id, plan_valid_until')
    .eq('user_code', user_code)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('user not found');
  return data;
}

export async function POST(req: NextRequest) {
  try {
    const { user_code, plan_type, force_cancel_existing = true } = await req.json();

    if (!user_code || !plan_type) {
      return NextResponse.json({ error: 'user_code and plan_type required' }, { status: 400 });
    }
    const planId = PLAN_IDS[plan_type];
    if (!planId) return NextResponse.json({ error: `Unknown plan_type: ${plan_type}` }, { status: 400 });

    const u = await getUser(user_code);
    if (!u.payjp_customer_id) {
      return NextResponse.json({ error: 'customer not registered (card required)' }, { status: 400 });
    }

    // 既存サブスクを終了（即時キャンセル）
    if (force_cancel_existing && u.payjp_subscription_id) {
      try {
        await payjp(`/subscriptions/${u.payjp_subscription_id}`, { method: 'DELETE' });
      } catch (e) {
        // 既に無効の可能性があるため握りつぶし
        console.warn('[subscribe/start] cancel old sub failed:', (e as Error)?.message);
      }
    }

    // 新規サブスク作成
    const sub = await payjp('/subscriptions', {
      method: 'POST',
      body: form({
        customer: u.payjp_customer_id,
        plan: planId,
      }),
    });

    const periodEnd: string | undefined = sub?.current_period_end || sub?.period?.end || null;

    // click_type を暫定反映（最終確定はWebhookでも行う）
    const newClick = plan_type; // 'pro' | 'master'
    const newPlan = mapClickToPlan(newClick);

    await supabaseAdmin
      .from('users')
      .update({
        click_type: newClick,
        plan_status: newPlan,
        plan_valid_until: periodEnd ?? null,
        payjp_subscription_id: sub?.id ?? null,
      })
      .eq('user_code', user_code);

    // 履歴を開始（openを締める→新規start）
    await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/pay/plan/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_code,
        new_click_type: newClick,
        reason: 'subscription.created(start)',
        source: 'api',
        plan_valid_until: periodEnd ?? null,
        payjp_subscription_id: sub?.id ?? null,
      }),
    });

    return NextResponse.json({ success: true, subscription_id: sub?.id, current_period_end: periodEnd });
  } catch (e: any) {
    console.error('[subscribe/start] error', e);
    return NextResponse.json({ error: e?.message || 'error' }, { status: 500 });
  }
}
