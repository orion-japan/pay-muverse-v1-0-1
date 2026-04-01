import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.PAYJP_WEBHOOK_SECRET || '';

function verifyWebhookToken(headerValue: string | null) {
  if (!WEBHOOK_SECRET) {
    console.error('[PAYJP_WEBHOOK] WEBHOOK_SECRET missing (dev)');
    return true;
  }
  return headerValue === WEBHOOK_SECRET;
}

async function findUserByCustomer(customerId: string) {
  if (!customerId) return null;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('user_code, payjp_subscription_id')
    .eq('payjp_customer_id', customerId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function clearCardStateByCustomer(customerId: string) {
  if (!customerId) return;

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      card_registered: false,
      card_brand: null,
      card_last4: null,
    })
    .eq('payjp_customer_id', customerId);

  if (error) throw error;
}

async function setCardStateByCustomer(
  customerId: string,
  brand?: string | null,
  last4?: string | null,
) {
  if (!customerId) return;

  const { error } = await supabaseAdmin
    .from('users')
    .update({
      card_registered: true,
      card_brand: brand ?? null,
      card_last4: last4 ?? null,
    })
    .eq('payjp_customer_id', customerId);

  if (error) throw error;
}

async function planApply(
  user_code: string,
  new_click_type: string,
  reason: string,
  periodEnd?: string | null,
  subId?: string | null,
) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? '';

  if (!baseUrl) {
    throw new Error('NEXT_PUBLIC_BASE_URL is missing');
  }

  const payload = {
    user_code,
    new_click_type,
    reason,
    source: 'webhook',
    plan_valid_until: periodEnd ?? null,
    payjp_subscription_id: subId ?? null,
  };

  console.error('[PAYJP_WEBHOOK] planApply payload=', JSON.stringify(payload));

  const res = await fetch(`${baseUrl}/api/pay/plan/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const text = await res.text().catch(() => '');

  console.error('[PAYJP_WEBHOOK] planApply response=', res.status, text);

  if (!res.ok) {
    throw new Error(`planApply failed: ${res.status} ${text}`);
  }
}

function resolveClickTypeFromSub(obj: any): string {
  const planId =
    obj?.plan || obj?.plan_id || obj?.items?.[0]?.plan || obj?.items?.[0]?.plan_id || null;

  if (!planId) return 'pro';

  const proId = process.env.PAYJP_PLAN_PRO_ID;
  const masterId = process.env.PAYJP_PLAN_MASTER_ID;

  if (masterId && String(planId) === String(masterId)) return 'master';
  if (proId && String(planId) === String(proId)) return 'pro';

  return 'pro';
}

export async function POST(req: NextRequest) {
  const raw = await req.text();

  console.error('🔥 WEBHOOK HIT');
  console.error('🔥 WEBHOOK RAW EVENT:', raw);

  const webhookToken =
    req.headers.get('x-payjp-webhook-token') ||
    req.headers.get('X-Payjp-Webhook-Token');

  console.error('[PAYJP_WEBHOOK] token exists =', Boolean(webhookToken));

  if (!verifyWebhookToken(webhookToken)) {
    console.error('[PAYJP_WEBHOOK] invalid token');
    return NextResponse.json({ error: 'invalid token' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    console.error('[PAYJP_WEBHOOK] invalid json');
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const type: string | undefined = event?.type;
  const eventId: string | null = event?.id ?? null;
  const data = event?.data ?? {};
  const obj = data?.object ?? data;
  const customerId = obj?.customer ?? data?.customer ?? null;
  const logPrefix = `[PAYJP_WEBHOOK ${type}]`;

  console.error('[PAYJP_WEBHOOK] event.id=', eventId);
  console.error('[PAYJP_WEBHOOK] event.type=', type);
  console.error('[PAYJP_WEBHOOK] customer=', customerId);
  console.error(logPrefix, 'received');

  try {
    switch (true) {
      case /^subscription\./.test(type || ''): {
        const user = await findUserByCustomer(customerId);

        console.error(logPrefix, 'userFound=', Boolean(user));

        if (!user) break;

        const status = obj?.status;
        const subId = obj?.id ?? null;
        const periodEnd = obj?.current_period_end ?? null;

        console.error(logPrefix, 'status=', status);

        if (status === 'active') {
          const clickType = resolveClickTypeFromSub(obj);
          await planApply(user.user_code, clickType, `webhook:${type}`, periodEnd, subId);
        } else {
          await planApply(user.user_code, 'free', `webhook:${type}`, null, null);
        }

        break;
      }

      case type === 'charge.succeeded': {
        console.error(logPrefix, 'charge success');
        break;
      }

      case type === 'customer.card.created': {
        const brand = obj?.brand ?? null;
        const last4 = obj?.last4 ?? null;

        console.error(logPrefix, 'card created');

        if (customerId) {
          await setCardStateByCustomer(customerId, brand, last4);
        }

        break;
      }

      case type === 'customer.card.deleted': {
        console.error(logPrefix, 'card deleted');

        if (customerId) {
          await clearCardStateByCustomer(customerId);
        }

        break;
      }

      default: {
        console.error(logPrefix, 'ignored');
        break;
      }
    }
  } catch (e: any) {
    console.error('[PAYJP_WEBHOOK] handler error:', e?.message || e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
