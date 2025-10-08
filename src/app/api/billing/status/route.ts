export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { cookies as nhCookies } from 'next/headers';

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}
const SB_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SRVKEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

async function readMuUserCode(req: NextRequest): Promise<string | null> {
  const v1 = req.cookies.get('mu_user_code')?.value?.trim();
  if (v1) return v1;

  try {
    const cOrPromise = nhCookies as unknown as () => any;
    let store = cOrPromise();
    if (store && typeof store.then === 'function') {
      store = await store;
    }
    const v2 = store?.get?.('mu_user_code')?.value?.trim?.();
    if (v2) return v2;
  } catch {
    /* noop */
  }
  return null;
}

export async function GET(req: NextRequest) {
  try {
    const fromCookie = await readMuUserCode(req);
    const fromHeader = req.headers.get('x-mu-user')?.trim() || null;
    const fromQuery  = req.nextUrl.searchParams.get('user_code')?.trim() || null;
    const user_code  = fromCookie || fromHeader || fromQuery;

    // user_code が無い場合でも 401 にせず 200 で未購入を返す（UIの赤ログ回避）
    if (!user_code) {
      return json({ active: false, plan: null, until: null, user_code: null, reason: 'no_user_code' }, 200);
    }

    const sb = createClient(SB_URL, SRVKEY, { auth: { persistSession: false } });
    const { data, error } = await sb
      .from('users')
      .select('plan_status, plan_until')
      .eq('user_code', user_code)
      .maybeSingle(); // 行がない場合もOKにする

    if (error) {
      return json({ active: false, plan: null, until: null, user_code, reason: error.message }, 200);
    }

    const plan  = data?.plan_status ?? null; // 'pro' | 'free' | null
    const until = data?.plan_until ?? null;  // ISO | null
    const now   = Date.now();
    const okUntil = until ? new Date(until).getTime() > now : true;
    const active = plan === 'pro' && okUntil;

    return json({ active, plan, until, user_code }, 200);
  } catch (e: any) {
    return json({ active: false, error: String(e?.message || e) }, 200);
  }
}
