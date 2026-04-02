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
    .select('user_code, payjp_subscription_id, payjp_customer_id')
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

  return { ok: true, status: res.status, text };
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

function toIsoFromPayjpTime(value: any): string | null {
  if (value == null) return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (/^\d+$/.test(trimmed)) {
      return new Date(Number(trimmed) * 1000).toISOString();
    }

    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
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
  const obj = typeof data === 'object' && data !== null ? data : {};
  const customerId = obj?.customer ?? null;

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

        await writeDebugRow({
          eventType: 'user_lookup',
          eventId,
          customerId,
          rawJson: {
            found: !!user,
            user,
          },
        });

        if (!user) {
          await writeDebugRow({
            eventType: 'user_not_found',
            eventId,
            customerId,
            rawJson: {
              message: 'No user matched payjp_customer_id',
            },
          });
          break;
        }

        const status = String(obj?.status ?? '').trim().toLowerCase();
        const subId = obj?.id ?? null;
        const rawPeriodEnd = obj?.current_period_end ?? obj?.period?.end ?? null;
        const periodEnd = toIsoFromPayjpTime(rawPeriodEnd);

        await writeDebugRow({
          eventType: 'subscription_status',
          eventId,
          customerId,
          rawJson: {
            status,
            subId,
            periodEnd,
            user_code: user.user_code,
          },
        });

        const { data: currentUserState, error: currentUserStateError } = await supabaseAdmin
        .from('users')
        .select('plan_status, plan_valid_until')
        .eq('user_code', user.user_code)
        .maybeSingle();

      if (currentUserStateError) {
        throw currentUserStateError;
      }

      const isCanceledGuard =
        currentUserState?.plan_status === 'canceled' &&
        (status === 'active' || status === 'trial' || status === 'trialing');

      if (isCanceledGuard) {
        await writeDebugRow({
          eventType: 'plan_apply_skipped_by_canceled_guard',
          eventId,
          customerId,
          rawJson: {
            user_code: user.user_code,
            incoming_status: status,
            current_plan_status: currentUserState?.plan_status ?? null,
            current_plan_valid_until: currentUserState?.plan_valid_until ?? null,
            subId,
            periodEnd,
          },
        });
        break;
      }

        if (status === 'active') {
          const clickType = resolveClickTypeFromSub(obj);

          await writeDebugRow({
            eventType: 'plan_apply_start',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              clickType,
              reason: `webhook:${type}`,
              periodEnd,
              subId,
            },
          });

          const result = await planApply(
            user.user_code,
            clickType,
            `webhook:${type}`,
            periodEnd,
            subId,
          );

          await writeDebugRow({
            eventType: 'plan_apply_done',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              clickType,
              result,
            },
          });
        } else if (status === 'trial' || status === 'trialing') {
          await writeDebugRow({
            eventType: 'plan_apply_start',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              clickType: 'trial',
              reason: `webhook:${type}`,
              periodEnd,
              subId,
            },
          });

          const result = await planApply(
            user.user_code,
            'trial',
            `webhook:${type}`,
            periodEnd,
            subId,
          );

          await writeDebugRow({
            eventType: 'env_check',
            eventId,
            customerId,
            rawJson: {
              has_service_role_key: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
              service_role_key_length: process.env.SUPABASE_SERVICE_ROLE_KEY
                ? process.env.SUPABASE_SERVICE_ROLE_KEY.length
                : 0,
              url: process.env.NEXT_PUBLIC_SUPABASE_URL,
            },
          });

          await writeDebugRow({
            eventType: 'plan_apply_done',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              clickType: 'trial',
              result,
            },
          });
        } else if (status === 'canceled') {
          await writeDebugRow({
            eventType: 'canceled_reserve_start',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              status,
              periodEnd,
              subId,
            },
          });

          const eventAt = new Date().toISOString();

          const { error: canceledError } = await supabaseAdmin.rpc(
            'apply_canceled_plan_by_user_code',
            {
              p_user_code: user.user_code,
              p_valid_until: periodEnd,
              p_event_at: eventAt,
            },
          );

          if (canceledError) {
            await writeDebugRow({
              eventType: 'canceled_reserve_error',
              eventId,
              customerId,
              rawJson: {
                user_code: user.user_code,
                status,
                periodEnd,
                error: canceledError,
              },
            });
            throw canceledError;
          }

          await writeDebugRow({
            eventType: 'canceled_reserve_done',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              status,
              periodEnd,
              eventAt,
              mode: 'rpc',
            },
          });
        } else if (['expired', 'terminated'].includes(status)) {
          await writeDebugRow({
            eventType: 'free_update_start',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              status,
            },
          });

          await writeDebugRow({
            eventType: 'update_try',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              using_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
            },
          });

          const eventAt = new Date().toISOString();

          const { error: freeUpdateError } = await supabaseAdmin.rpc(
            'apply_free_plan_by_user_code',
            {
              p_user_code: user.user_code,
              p_event_at: eventAt,
            },
          );

          if (freeUpdateError) {
            await writeDebugRow({
              eventType: 'free_update_error',
              eventId,
              customerId,
              rawJson: {
                user_code: user.user_code,
                error: freeUpdateError,
              },
            });
            throw freeUpdateError;
          }

          await writeDebugRow({
            eventType: 'free_update_done',
            eventId,
            customerId,
            rawJson: {
              user_code: user.user_code,
              eventAt,
              mode: 'rpc',
            },
          });
        } else if (status === 'paused' || status === 'past_due') {
          await writeDebugRow({
            eventType: 'subscription_status_skipped_pending_policy',
            eventId,
            customerId,
            rawJson: {
              status,
              user_code: user.user_code,
              note: 'paused / past_due policy is not fixed yet',
            },
          });
        } else {
          await writeDebugRow({
            eventType: 'subscription_status_skipped',
            eventId,
            customerId,
            rawJson: {
              status,
              user_code: user.user_code,
            },
          });
        }

        break;
      }

      case type === 'charge.succeeded': {
        await writeDebugRow({
          eventType: 'charge_succeeded_seen',
          eventId,
          customerId,
          rawJson: { type },
        });
        break;
      }

      case type === 'customer.card.created': {
        const brand = obj?.brand ?? null;
        const last4 = obj?.last4 ?? null;

        if (customerId) {
          await setCardStateByCustomer(customerId, brand, last4);

          await writeDebugRow({
            eventType: 'card_created_done',
            eventId,
            customerId,
            rawJson: {
              brand,
              last4,
            },
          });
        }

        break;
      }

      case type === 'customer.card.deleted': {
        if (customerId) {
          await clearCardStateByCustomer(customerId);

          await writeDebugRow({
            eventType: 'card_deleted_done',
            eventId,
            customerId,
            rawJson: {},
          });
        }

        break;
      }

      case type === 'customer.deleted': {
        const deletedCustomerId = obj?.id ?? null;

        if (deletedCustomerId) {
          await clearCardStateByCustomer(deletedCustomerId);

          await writeDebugRow({
            eventType: 'customer_deleted_done',
            eventId,
            customerId: deletedCustomerId,
            rawJson: {},
          });
        }

        break;
      }

      default: {
        await writeDebugRow({
          eventType: 'event_skipped',
          eventId,
          customerId,
          rawJson: {
            type,
          },
        });
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

    return NextResponse.json(
      { ok: false, error: e?.message ?? 'webhook failed' },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
