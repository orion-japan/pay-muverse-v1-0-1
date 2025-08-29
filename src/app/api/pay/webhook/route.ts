import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WEBHOOK_SECRET = process.env.PAYJP_WEBHOOK_SECRET || '';

function timingSafeEq(a: Buffer, b: Buffer) {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function parseSigHeader(v: string | null) {
  if (!v) return { raw: null, v1: null };
  // Stripe風: "t=xxx,v1=xxxxx"
  const parts = v.split(',').map((s) => s.trim());
  const v1 = parts.find((p) => p.startsWith('v1='))?.slice(3) || null;
  return { raw: v, v1 };
}

function verifySignature(raw: string, headerValue: string | null) {
  if (!WEBHOOK_SECRET) {
    console.warn('[webhook] WEBHOOK_SECRET missing. Skip verification.');
    return true; // 開発時のみ
  }
  const { v1 } = parseSigHeader(headerValue);
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
  const candidate = v1 ?? headerValue ?? '';
  return timingSafeEq(Buffer.from(expected), Buffer.from(candidate));
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

async function planApply(user_code: string, new_click_type: string, reason: string, periodEnd?: string | null, subId?: string | null) {
  await fetch(`${process.env.NEXT_PUBLIC_BASE_URL ?? ''}/api/pay/plan/apply`, {
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
  });
}

function resolveClickTypeFromSub(obj: any): string {
  // plan / product から click_type を決める
  const planId = obj?.plan || obj?.plan_id || obj?.items?.[0]?.plan || obj?.items?.[0]?.plan_id || null;
  if (!planId) return 'pro'; // 既定
  const proId = process.env.PAYJP_PLAN_PRO_ID;
  const masterId = process.env.PAYJP_PLAN_MASTER_ID;
  if (masterId && String(planId) === String(masterId)) return 'master';
  if (proId && String(planId) === String(proId)) return 'pro';
  return 'pro';
}

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const sigHeader =
    req.headers.get('payjp-signature') ||
    req.headers.get('Payjp-Signature') ||
    req.headers.get('PAYJP-Signature') ||
    req.headers.get('x-payjp-signature');

  if (!verifySignature(raw, sigHeader)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 });
  }

  const type = event?.type;
  const obj = event?.data?.object;

  try {
    switch (true) {
      case /^subscription\./.test(type || ''): {
        const customerId = obj?.customer;
        const user = await findUserByCustomer(customerId);
        if (!user) break;

        const status: string | undefined = obj?.status; // 'active'|'trial'|'canceled'|'paused'|'past_due'|'expired'
        const periodEnd: string | undefined = obj?.current_period_end || obj?.period?.end || null;

        if (status === 'active') {
          const click = resolveClickTypeFromSub(obj); // pro/master
          await planApply(user.user_code, click, `webhook:${type}`, periodEnd, obj?.id ?? null);
        } else if (status === 'trial') {
          await planApply(user.user_code, 'trial', `webhook:${type}`, periodEnd, obj?.id ?? null);
        } else if (['canceled', 'paused', 'past_due', 'expired', 'terminated'].includes(String(status || ''))) {
          await planApply(user.user_code, 'free', `webhook:${type}`, null, null);
        }
        break;
      }

      case type === 'charge.succeeded': {
        const customerId = obj?.customer;
        const user = await findUserByCustomer(customerId);
        if (!user) break;
        // 必要なら都度課金でプロ化するなどの運用をここに追加可能
        break;
      }

      default:
        // 他イベントはログのみ
        break;
    }
  } catch (e) {
    console.error('[PAY_WEBHOOK] error', e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
