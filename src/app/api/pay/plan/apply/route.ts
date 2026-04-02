import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ApplyBody = {
  user_code?: string;
  new_click_type?: string;
  reason?: string;
  source?: string;
  plan_valid_until?: string | null;
  payjp_subscription_id?: string | null;
};

function normalizeClickType(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'pro') return 'premium';
  return raw;
}

function resolveCredit(clickType: string): number {
  const envMap: Record<string, string | undefined> = {
    regular: process.env.PAY_PLAN_REGULAR_CREDIT ?? '500',
    premium: process.env.PAY_PLAN_PRO_CREDIT,
    master: process.env.PAY_PLAN_MASTER_CREDIT,
    trial: process.env.PAY_PLAN_TRIAL_CREDIT,
    free: '0',
  };

  const raw = envMap[clickType];
  if (raw == null || raw === '') {
    throw new Error(`credit env is missing for click_type=${clickType}`);
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) {
    throw new Error(`credit env is invalid for click_type=${clickType}: ${raw}`);
  }

  return num;
}

function resolvePlanStatus(clickType: string): string {
  if (clickType === 'trial') return 'trial';
  if (clickType === 'free') return 'free';
  return clickType;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as ApplyBody;

    const user_code = String(body.user_code ?? '').trim();
    const new_click_type = normalizeClickType(body.new_click_type);
    const reason = String(body.reason ?? 'plan.apply').trim() || 'plan.apply';
    const source = String(body.source ?? 'system').trim() || 'system';
    const plan_valid_until = body.plan_valid_until ?? null;
    const payjp_subscription_id = body.payjp_subscription_id ?? null;

    if (!user_code || !new_click_type) {
      return NextResponse.json(
        { ok: false, error: 'user_code and new_click_type required' },
        { status: 400 },
      );
    }

    const allowedClickTypes = ['regular', 'premium', 'master', 'trial', 'free'];
    if (!allowedClickTypes.includes(new_click_type)) {
      return NextResponse.json(
        { ok: false, error: `unsupported new_click_type: ${new_click_type}` },
        { status: 400 },
      );
    }

    const { data: beforeUser, error: beforeError } = await supabaseAdmin
      .from('users')
      .select(
        'user_code, click_type, plan_status, sofia_credit, plan_valid_until, payjp_subscription_id',
      )
      .eq('user_code', user_code)
      .maybeSingle();

    if (beforeError) throw beforeError;
    if (!beforeUser) {
      return NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 });
    }

    const new_plan = resolvePlanStatus(new_click_type);
    const credit = resolveCredit(new_click_type);

    const { error: rpcError } = await supabaseAdmin.rpc('apply_paid_plan_by_user_code', {
      p_user_code: user_code,
      p_click_type: new_click_type,
      p_plan_status: new_plan,
      p_sofia_credit: credit,
      p_valid_until: plan_valid_until,
      p_payjp_subscription_id: payjp_subscription_id,
      p_event_at: new Date().toISOString(),
    });

    if (rpcError) throw rpcError;

    const historyRow = {
      user_code,
      plan_type: new_click_type,
      change_source: source,
      effective_from: new Date().toISOString(),
      notes: reason,
      note: {
        reason,
        source,
        before: {
          click_type: beforeUser.click_type ?? null,
          plan_status: beforeUser.plan_status ?? null,
          sofia_credit: beforeUser.sofia_credit ?? null,
          plan_valid_until: beforeUser.plan_valid_until ?? null,
          payjp_subscription_id: beforeUser.payjp_subscription_id ?? null,
        },
        after: {
          click_type: new_click_type,
          plan_status: new_plan,
          sofia_credit: credit,
          plan_valid_until,
          payjp_subscription_id,
        },
      },
      event: reason,
      plan_status: new_plan,
      click_type: new_click_type,
      valid_until: plan_valid_until,
      source,
    };

    const { error: histError } = await supabaseAdmin.from('plan_history').insert(historyRow);

    if (histError) throw histError;

    const { data: afterUser, error: afterError } = await supabaseAdmin
      .from('users')
      .select(
        'user_code, click_type, plan_status, sofia_credit, plan_valid_until, payjp_subscription_id',
      )
      .eq('user_code', user_code)
      .maybeSingle();

    if (afterError) throw afterError;

    return NextResponse.json({
      ok: true,
      applied: {
        user_code,
        click_type: afterUser?.click_type ?? new_click_type,
        plan_status: afterUser?.plan_status ?? new_plan,
        sofia_credit: afterUser?.sofia_credit ?? credit,
        plan_valid_until: afterUser?.plan_valid_until ?? plan_valid_until,
        payjp_subscription_id: afterUser?.payjp_subscription_id ?? payjp_subscription_id,
      },
    });
  } catch (e: any) {
    console.error('[api/pay/plan/apply] error', e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'plan apply failed' },
      { status: 500 },
    );
  }
}
