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

function pickImaginalCopy(seed: unknown): string | null {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed)) return null;
  const obj = seed as Record<string, unknown>;
  const value = obj.imaginal_copy ?? obj.imaginalCopy ?? obj.imajinal_copy;
  const s = String(value ?? '').trim();
  return s || null;
}

export async function GET(req: NextRequest) {
  const authzRaw = await verifyFirebaseAndAuthorize(req);
  const authz = normalizeAuthz(authzRaw);
  const userCode = authz.user?.user_code;

  if (authz.error || !userCode) {
    return json({ ok: false, error: 'unauthorized' }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  const { data: userRow, error: userErr } = await sb
    .from('users')
    .select('mu_first_onboarding_pending, mu_first_onboarding_activated_at, mu_first_onboarding_consumed_at')
    .eq('user_code', userCode)
    .maybeSingle();

  if (userErr) {
    console.warn('[mu-first-onboarding/bootstrap] user fetch failed:', userErr.message);
    return json({ ok: false, error: 'user_fetch_failed' }, 500);
  }

  if (!userRow?.mu_first_onboarding_pending) {
    return json({ ok: true, should_bootstrap: false });
  }

  const { data: latest, error: latestErr } = await sb
    .from('mu_screenshot_diagnosis_logs')
    .select('id, diagnosis_text, diagnosis_seed_json, used_at, created_at')
    .eq('user_code', userCode)
    .eq('source', 'mu_first')
    .not('diagnosis_text', 'is', null)
    .order('used_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (latestErr) {
    console.warn('[mu-first-onboarding/bootstrap] latest diagnosis failed:', latestErr.message);
    return json({ ok: false, error: 'diagnosis_fetch_failed' }, 500);
  }

  if (!latest?.id || !latest?.diagnosis_text) {
    return json({ ok: false, error: 'missing_first_diagnosis' }, 404);
  }

  const { data: followups } = await sb
    .from('mu_first_followup_logs')
    .select('question, answer, created_at')
    .eq('user_code', userCode)
    .eq('diagnosis_log_id', latest.id)
    .order('created_at', { ascending: true })
    .limit(3);

  await sb
    .from('users')
    .update({
      mu_first_onboarding_pending: false,
      mu_first_onboarding_consumed_at: new Date().toISOString(),
    })
    .eq('user_code', userCode);

  const imaginalCopy = pickImaginalCopy(latest.diagnosis_seed_json);
  const message = imaginalCopy
    ? [
        'さっきのイマジナル診断では、',
        `私のイマジナルコピーは「${imaginalCopy}」でした。`,
        '',
        'ここから、創造の方向を一緒に見てください。',
      ].join('\n')
    : 'さっきのイマジナル診断から、創造の方向を一緒に見てください。';

  return json({
    ok: true,
    should_bootstrap: true,
    message,
    firstDiagnosisContext: {
      source: 'mu_first',
      diagnosisKind: 'imaginal_first',
      diagnosisId: latest.id,
      diagnosisText: latest.diagnosis_text,
      diagnosisSeed: latest.diagnosis_seed_json ?? null,
      imaginalCopy,
      followups: Array.isArray(followups) ? followups : [],
    },
  });
}
