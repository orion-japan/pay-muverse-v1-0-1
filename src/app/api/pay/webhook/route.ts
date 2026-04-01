import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.PAYJP_WEBHOOK_SECRET || '';

function verifyWebhookToken(headerValue: string | null) {
  if (!WEBHOOK_SECRET) return true;
  return headerValue === WEBHOOK_SECRET;
}

async function writeDebugRow(params: {
  eventType?: string | null;
  eventId?: string | null;
  customerId?: string | null;
  rawJson?: any;
}) {
  const { error } = await supabaseAdmin.from('payjp_webhook_debug').insert({
    event_type: params.eventType ?? null,
    event_id: params.eventId ?? null,
    customer_id: params.customerId ?? null,
    raw_json: params.rawJson ?? null,
  });

  if (error) {
    throw new Error(`debug insert failed: ${error.message}`);
  }
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

  const res = await fetch(`${baseUrl}/api/pay/plan/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_code,
      new_click_type,
      reason,
      source: 'webhook',
      plan_valid_until: periodEnd ?? null,
      payjp_subscription_id: subId ?? null,
    }),
    cache: 'no-store',
  });

  const text = await res.text().catch(() => '');

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

  const webhookToken =
    req.headers.get('x-payjp-webhook-token') ||
    req.headers.get('X-Payjp-Webhook-Token');

  if (!verifyWebhookToken(webhookToken)) {
    return NextResponse.json({ error: 'invalid token' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    await writeDebugRow({
      eventType: 'invalid_json',
      eventId: null,
      customerId: null,
      rawJson: { raw },
    });
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const type: string | undefined = event?.type;
  const eventId: string | null = event?.id ?? null;
  const data = event?.data ?? {};
  const obj = data?.object ?? data;
  const customerId = obj?.customer ?? data?.customer ?? null;

  try {
    await writeDebugRow({
      eventType: type ?? null,
      eventId,
      customerId,
      rawJson: event,
    });

    switch (true) {
      case /^subscription\./.test(type || ''): {
        const user = await findUserByCustomer(customerId);

        if (!user) break;

        const status = obj?.status;
        const subId = obj?.id ?? null;
        const periodEnd = obj?.current_period_end ?? obj?.period?.end ?? null;

        if (status === 'active') {
          const clickType = resolveClickTypeFromSub(obj);
          await planApply(user.user_code, clickType, `webhook:${type}`, periodEnd, subId);
        } else if (status === 'trial' || status === 'trialing') {
          await planApply(user.user_code, 'trial', `webhook:${type}`, periodEnd, subId);
        } else if (
          ['canceled', 'paused', 'past_due', 'expired', 'terminated'].includes(
            String(status || ''),
          )
        ) {
          await planApply(user.user_code, 'free', `webhook:${type}`, null, null);
        }

        break;
      }

      case type === 'charge.succeeded': {
        break;
      }

      case type === 'customer.card.created': {
        const brand = obj?.brand ?? data?.object?.brand ?? null;
        const last4 = obj?.last4 ?? data?.object?.last4 ?? null;

        if (customerId) {
          await setCardStateByCustomer(customerId, brand, last4);
        }

        break;
      }

      case type === 'customer.card.deleted': {
        if (customerId) {
          await clearCardStateByCustomer(customerId);
        }

        break;
      }

      case type === 'customer.deleted': {
        const deletedCustomerId = obj?.id ?? data?.id ?? null;

        if (deletedCustomerId) {
          await clearCardStateByCustomer(deletedCustomerId);
        }

        break;
      }

      default: {
        break;
      }
    }
  } catch (e: any) {
    await writeDebugRow({
      eventType: 'handler_error',
      eventId,
      customerId,
      rawJson: {
        message: e?.message ?? String(e),
        event,
      },
    });

    return NextResponse.json({ ok: false, error: e?.message ?? 'webhook failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
