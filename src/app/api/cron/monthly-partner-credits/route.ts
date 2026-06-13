// src/app/api/cron/monthly-partner-credits/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const MASTER_PARTNER_CREDIT_AMOUNT = 3500;
const GRANT_TYPE = 'monthly_partner';
const PARTNER_TYPE = 'partner';
const DEFAULT_REASON = 'マスターパートナー月次自動付与';

type PartnerUserRow = {
  user_code: string | number | null;
  click_type?: string | null;
  plan_status?: string | null;
};

type GrantResult = {
  user_code: string;
  status: 'granted' | 'skipped' | 'failed';
  op_id?: string;
  error?: string;
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status });
}

function getTokyoGrantMonth(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);

  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;

  if (!year || !month) {
    throw new Error('failed_to_resolve_tokyo_grant_month');
  }

  return `${year}-${month}`;
}

function isValidGrantMonth(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value);
}

function isCronAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) return false;

  const authorization = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const urlSecret = new URL(req.url).searchParams.get('secret')?.trim() || '';

  return authorization === `Bearer ${cronSecret}` || urlSecret === cronSecret;
}

async function isAdminAuthorized(req: NextRequest): Promise<boolean> {
  const auth = await verifyFirebaseAndAuthorize(req);
  if (!auth.ok || !auth.userCode) return false;

  const { data, error } = await supabaseAdmin
    .from('users')
    .select('click_type, plan_status')
    .eq('user_code', auth.userCode)
    .maybeSingle();

  if (error || !data) return false;

  const clickType = String((data as any).click_type ?? '').toLowerCase();
  const planStatus = String((data as any).plan_status ?? '').toLowerCase();

  return clickType === 'admin' || planStatus === 'admin';
}

async function authorize(req: NextRequest): Promise<boolean> {
  if (isCronAuthorized(req)) return true;
  return isAdminAuthorized(req);
}

async function loadPartnerUsers(): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('user_code, click_type, plan_status')
    .or('click_type.eq.partner,plan_status.eq.partner');

  if (error) throw new Error(`partner_user_fetch_failed: ${error.message}`);

  return ((data ?? []) as PartnerUserRow[])
    .map((row) => String(row.user_code ?? '').trim())
    .filter(Boolean);
}

async function loadAlreadyGrantedUserCodes(grantMonth: string): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('credit_grant_logs')
    .select('user_code')
    .eq('grant_type', GRANT_TYPE)
    .eq('grant_month', grantMonth);

  if (error) throw new Error(`grant_log_fetch_failed: ${error.message}`);

  return new Set(
    ((data ?? []) as Array<{ user_code?: string | number | null }>)
      .map((row) => String(row.user_code ?? '').trim())
      .filter(Boolean),
  );
}

async function grantToPartner(userCode: string, grantMonth: string): Promise<GrantResult> {
  const opId = `${GRANT_TYPE}-${grantMonth}-${userCode}`;

  const { error: rpcError } = await supabaseAdmin.rpc('grant_sofia_credit_by_user_code', {
    p_user_code: userCode,
    p_amount: MASTER_PARTNER_CREDIT_AMOUNT,
    p_reason: `${GRANT_TYPE}:${grantMonth}`,
    p_idempotency_key: opId,
  });

  if (rpcError) {
    return {
      user_code: userCode,
      status: 'failed',
      op_id: opId,
      error: rpcError.message,
    };
  }

  const { error: logError } = await supabaseAdmin
    .from('credit_grant_logs')
    .upsert(
      {
        user_code: userCode,
        user_type: PARTNER_TYPE,
        grant_type: GRANT_TYPE,
        amount: MASTER_PARTNER_CREDIT_AMOUNT,
        grant_month: grantMonth,
        reason: DEFAULT_REASON,
        op_id: opId,
        metadata: {
          formal_role_name: 'マスターパートナー',
          display_role_name: 'パートナー',
        },
      },
      { onConflict: 'user_code,grant_type,grant_month' },
    );

  if (logError) {
    return {
      user_code: userCode,
      status: 'failed',
      op_id: opId,
      error: `grant_log_write_failed: ${logError.message}`,
    };
  }

  return { user_code: userCode, status: 'granted', op_id: opId };
}

async function handle(req: NextRequest) {
  try {
    const authorized = await authorize(req);
    if (!authorized) return json({ ok: false, error: 'unauthorized' }, 401);

    const url = new URL(req.url);
    const dryRun = url.searchParams.get('dry_run') === '1';
    const requestedGrantMonth = url.searchParams.get('grant_month')?.trim();
    const grantMonth = requestedGrantMonth || getTokyoGrantMonth();

    if (!isValidGrantMonth(grantMonth)) {
      return json({ ok: false, error: 'invalid_grant_month', grant_month: grantMonth }, 400);
    }

    const partnerUserCodes = await loadPartnerUsers();
    const alreadyGranted = await loadAlreadyGrantedUserCodes(grantMonth);

    const results: GrantResult[] = [];
    const targets = partnerUserCodes.filter((userCode) => {
      if (alreadyGranted.has(userCode)) {
        results.push({ user_code: userCode, status: 'skipped' });
        return false;
      }
      return true;
    });

    if (!dryRun) {
      for (const userCode of targets) {
        results.push(await grantToPartner(userCode, grantMonth));
      }
    } else {
      for (const userCode of targets) {
        results.push({
          user_code: userCode,
          status: 'skipped',
          op_id: `${GRANT_TYPE}-${grantMonth}-${userCode}`,
        });
      }
    }

    const granted = results.filter((r) => r.status === 'granted').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const failed = results.filter((r) => r.status === 'failed').length;

    return json({
      ok: failed === 0,
      dry_run: dryRun,
      role: PARTNER_TYPE,
      display_role_name: 'パートナー',
      formal_role_name: 'マスターパートナー',
      grant_type: GRANT_TYPE,
      grant_month: grantMonth,
      amount: MASTER_PARTNER_CREDIT_AMOUNT,
      total_partner_users: partnerUserCodes.length,
      granted,
      skipped,
      failed,
      results,
    }, failed === 0 ? 200 : 207);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled', detail: String(e?.message ?? e) }, 500);
  }
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}



