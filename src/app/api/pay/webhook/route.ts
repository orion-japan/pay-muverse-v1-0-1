// src/app/api/pay/webhook/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.PAYJP_WEBHOOK_SECRET || '';

/* =========================
   Token verification
   ========================= */
function verifyWebhookToken(headerValue: string | null) {
  if (!WEBHOOK_SECRET) {
    console.warn('[PAYJP_WEBHOOK] WEBHOOK_SECRET missing. Skip verification (dev only).');
    return true;
  }
  return headerValue === WEBHOOK_SECRET;
}

/* =========================
   DB helpers
   ========================= */
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

/* =========================
   Subscription helpers
   ========================= */
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

  console.log('[PAYJP_WEBHOOK] planApply payload=', JSON.stringify(payload));

  const res = await fetch(`${baseUrl}/api/pay/plan/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  const text = await res.text().catch(() => '');

  console.log('[PAYJP_WEBHOOK] planApply response=', res.status, text);

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

/* =========================
   Main handler
   ========================= */
export async function POST(req: NextRequest) {
  const raw = await req.text();

  const webhookToken =
    req.headers.get('x-payjp-webhook-token') ||
    req.headers.get('X-Payjp-Webhook-Token');

  console.log('[PAYJP_WEBHOOK] token header exists =', Boolean(webhookToken));

  if (!verifyWebhookToken(webhookToken)) {
    console.warn('[PAYJP_WEBHOOK] invalid token');
    return NextResponse.json({ error: 'invalid token' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    console.warn('[PAYJP_WEBHOOK] invalid json');
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const type: string | undefined = event?.type;
  const eventId: string | null = event?.id ?? null;
  const data = event?.data ?? {};
  const obj = data?.object ?? data;
  const customerIdFromEvent = obj?.customer ?? data?.customer ?? null;
  const logPrefix = `[PAYJP_WEBHOOK ${type}]`;

  console.log('[PAYJP_WEBHOOK] event.id=', eventId);
  console.log('[PAYJP_WEBHOOK] event.type=', type ?? null);
  console.log('[PAYJP_WEBHOOK] customer=', customerIdFromEvent);
  console.log(logPrefix, 'received');

  try {
    switch (true) {
      /* ---------- Subscription 系 ---------- */
      case /^subscription\./.test(type || ''): {
        const customerId = customerIdFromEvent;
        const user = await findUserByCustomer(customerId);

        console.log(logPrefix, 'customerId=', customerId, 'userFound=', Boolean(user));

        if (!user) {
          console.log(logPrefix, 'no matched user by payjp_customer_id');
          break;
        }

        const status: string | undefined = obj?.status;
        const subId: string | null = obj?.id ?? null;
        const periodEnd: string | null = obj?.current_period_end || obj?.period?.end || null;

        console.log(logPrefix, 'status=', status ?? null, 'subId=', subId, 'periodEnd=', periodEnd);

        if (status === 'active') {
          const clickType = resolveClickTypeFromSub(obj);
          console.log(logPrefix, 'apply clickType=', clickType);

          await planApply(
            user.user_code,
            clickType,
            `webhook:${type}`,
            periodEnd,
            subId,
          );
        } else if (status === 'trial' || status === 'trialing') {
          console.log(logPrefix, 'apply clickType=trial');

          await planApply(
            user.user_code,
            'trial',
            `webhook:${type}`,
            periodEnd,
            subId,
          );
        } else if (
          ['canceled', 'paused', 'past_due', 'expired', 'terminated'].includes(
            String(status || ''),
          )
        ) {
          console.log(logPrefix, 'apply clickType=free');

          await planApply(
            user.user_code,
            'free',
            `webhook:${type}`,
            null,
            null,
          );
        } else {
          console.log(logPrefix, 'subscription status ignored');
        }

        break;
      }

      case type === 'charge.succeeded': {
        const customerId = customerIdFromEvent;
        const user = await findUserByCustomer(customerId);

        console.log(logPrefix, 'customerId=', customerId, 'userFound=', Boolean(user));

        if (!user) {
          console.log(logPrefix, 'no matched user by payjp_customer_id');
          break;
        }

        console.log(logPrefix, 'charge.succeeded received');
        break;
      }

      /* ---------- Card / Customer 系 ---------- */
      case type === 'customer.card.deleted': {
        const customerId = customerIdFromEvent;

        console.log(logPrefix, 'customerId=', customerId);

        if (customerId) {
          await clearCardStateByCustomer(customerId);
          console.log(logPrefix, 'card state cleared');
        } else {
          console.warn(`${logPrefix} missing customer id; skip DB sync`);
        }

        break;
      }

      case type === 'customer.card.created': {
        const customerId = customerIdFromEvent;
        const brand = obj?.brand ?? data?.object?.brand ?? null;
        const last4 = obj?.last4 ?? data?.object?.last4 ?? null;

        console.log(logPrefix, 'customerId=', customerId, 'brand=', brand, 'last4=', last4);

        if (customerId) {
          await setCardStateByCustomer(customerId, brand, last4);
          console.log(logPrefix, 'card state updated');
        } else {
          console.warn(`${logPrefix} missing customer id; skip DB sync`);
        }

        break;
      }

      case type === 'customer.deleted': {
        const customerId = obj?.id ?? data?.id ?? null;

        console.log(logPrefix, 'customerId=', customerId);

        if (customerId) {
          await clearCardStateByCustomer(customerId);
          console.log(logPrefix, 'customer deleted -> card state cleared');
        }

        break;
      }

      default: {
        console.log(logPrefix, 'ignored');
        break;
      }
    }
  } catch (e: any) {
    console.error('[PAYJP_WEBHOOK] handler error:', e?.message || e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
