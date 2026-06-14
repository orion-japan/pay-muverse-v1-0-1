import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  normalizeAuthz,
  SERVICE_ROLE,
  SUPABASE_URL,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: NextRequest) {
  const authzRaw = await verifyFirebaseAndAuthorize(req);
  const authz = normalizeAuthz(authzRaw);
  const userCode = authz.user?.user_code;

  if (authz.error || !userCode) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { data: latest, error: latestErr } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .select('id')
    .eq('user_code', userCode)
    .eq('source', 'mu_first')
    .not('diagnosis_text', 'is', null)
    .order('used_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    console.warn('[mu-first-onboarding/activate] latest diagnosis failed:', latestErr.message);
    return json({ ok: false, error: 'diagnosis_fetch_failed' }, 500);
  }

  if (!latest?.id) {
    return json({ ok: false, error: 'missing_first_diagnosis' }, 404);
  }

  const { error } = await sb
    .from('users')
    .update({
      mu_first_onboarding_pending: true,
      mu_first_onboarding_activated_at: new Date().toISOString(),
      mu_first_onboarding_consumed_at: null,
    })
    .eq('user_code', userCode);

  if (error) {
    console.warn('[mu-first-onboarding/activate] update failed:', error.message);
    return json({ ok: false, error: 'activate_failed' }, 500);
  }

  return json({ ok: true });
}
