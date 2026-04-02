import { NextRequest, NextResponse } from 'next/server';

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

function getSupabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!key) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');

  return { url: url.replace(/\/$/, ''), key };
}

async function sbFetch<T = any>(
  path: string,
  init?: {
    method?: 'GET' | 'POST' | 'PATCH';
    body?: unknown;
    prefer?: string;
  },
): Promise<T> {
  const { url, key } = getSupabaseEnv();

  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(init?.prefer ? { Prefer: init.prefer } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new Error(
      `Supabase REST ${init?.method ?? 'GET'} ${path} failed: ${res.status} ${
        typeof data === 'object' ? JSON.stringify(data) : text
      }`,
    );
  }

  return data as T;
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

    const users = await sbFetch<any[]>(
      `users?select=user_code,click_type,plan_status&user_code=eq.${encodeURIComponent(user_code)}`,
      { method: 'GET' },
    );

    const u = users?.[0] ?? null;
    if (!u) {
      return NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 });
    }

    const old_click = u.click_type ?? null;
    const old_plan = u.plan_status ?? null;
    const new_plan = new_click_type;
    const credit = resolveCredit(new_click_type);

    const updatePayload: Record<string, unknown> = {
      click_type: new_click_type,
      plan_status: new_plan,
      sofia_credit: credit,
    };

    if (plan_valid_until !== null) {
      updatePayload.plan_valid_until = plan_valid_until;
      updatePayload.next_payment_date = plan_valid_until;
    }

    if (payjp_subscription_id !== null) {
      updatePayload.payjp_subscription_id = payjp_subscription_id;
    }

    const updatedUsers = await sbFetch<any[]>(
      `users?user_code=eq.${encodeURIComponent(user_code)}`,
      {
        method: 'PATCH',
        body: updatePayload,
        prefer: 'return=representation',
      },
    );

    const updatedUser = updatedUsers?.[0] ?? null;

    const openHist = await sbFetch<any[]>(
      `plan_history?select=id&user_code=eq.${encodeURIComponent(user_code)}&ended_at=is.null&order=started_at.desc&limit=1`,
      { method: 'GET' },
    );

    if (openHist && openHist[0]?.id != null) {
      await sbFetch<any[]>(
        `plan_history?id=eq.${encodeURIComponent(String(openHist[0].id))}`,
        {
          method: 'PATCH',
          body: { ended_at: new Date().toISOString() },
          prefer: 'return=representation',
        },
      );
    }

    await sbFetch<any[]>('plan_history', {
      method: 'POST',
      body: {
        user_code,
        from_click_type: old_click,
        to_click_type: new_click_type,
        from_plan_status: old_plan,
        to_plan_status: new_plan,
        reason,
        source,
        started_at: new Date().toISOString(),
      },
      prefer: 'return=representation',
    });

    return NextResponse.json({
      ok: true,
      applied: {
        user_code,
        click_type: updatedUser?.click_type ?? new_click_type,
        plan_status: updatedUser?.plan_status ?? new_plan,
        sofia_credit: updatedUser?.sofia_credit ?? credit,
        plan_valid_until: updatedUser?.plan_valid_until ?? plan_valid_until,
        payjp_subscription_id: updatedUser?.payjp_subscription_id ?? payjp_subscription_id,
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
