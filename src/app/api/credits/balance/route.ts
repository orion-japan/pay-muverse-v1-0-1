// file: src/app/api/credits/balance/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-User-Code, x-user-code',
} as const;

const RESP_HEADERS = {
  ...CORS,
  'Cache-Control': 'no-store',
  'x-handler': 'app/api/credits/balance',
} as const;

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

/** getSupabase の明示ユニオン型（null as const を使わない） */
type SBInitOk = { err: null; sb: SupabaseClient };
type SBInitErr = { err: string; sb: null };
type SBInit = SBInitOk | SBInitErr;

// --- 遅延初期化（ENV不足でもサーバを落とさず 500 を返す） ---
function getSupabase(): SBInit {
  const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
  const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

  if (!SUPABASE_URL) return { err: 'ENV NEXT_PUBLIC_SUPABASE_URL is missing', sb: null };

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE || SUPABASE_ANON, {
    auth: { persistSession: false },
  });
  return { err: null, sb };
}

function pickUserCode(req: NextRequest, body?: any): string | null {
  const url = new URL(req.url);
  const q = url.searchParams.get('user_code');
  if (q && q.trim()) return q.trim();

  const hx = req.headers.get('x-user-code') || req.headers.get('X-User-Code');
  if (hx && hx.trim()) return hx.trim();

  const fromBody = String(body?.user_code ?? '').trim();
  return fromBody || null;
}

async function fetchBalance(sb: SupabaseClient, user_code: string) {
  // ① users.sofia_credit（最優先）
  const { data: userRow, error: userErr } = await sb
    .from('users')
    .select('sofia_credit')
    .eq('user_code', user_code)
    .maybeSingle();

  if (!userErr && userRow && userRow.sofia_credit != null) {
    const remaining = Number(userRow.sofia_credit) || 0;
    return {
      ok: true,
      user_code,
      balance: remaining,
      source: 'users.sofia_credit',
      details: { sofia_credit: remaining },
    } as const;
  }

  // ② ledger 合計
  const { data: rows, error: sumErr } = await sb
    .from('credits_ledger')
    .select('delta')
    .eq('user_code', user_code);

  if (sumErr) {
    return {
      ok: false,
      user_code,
      balance: 0,
      source: 'error',
      details: { message: `sum failed: ${sumErr.message}`, stage: 'ledger_sum' },
    } as const;
  }

  const sumDelta = (rows ?? []).reduce((acc, r: any) => acc + Number(r?.delta ?? 0), 0);
  return {
    ok: true,
    user_code,
    balance: sumDelta,
    source: 'sum_only',
    details: { sum_delta: sumDelta, rows: rows?.length ?? 0 },
  } as const;
}

export async function GET(req: NextRequest) {
  const user_code = pickUserCode(req);
  if (!user_code) {
    return NextResponse.json(
      { ok: false, user_code: null, balance: 0, source: 'error', details: { message: 'user_code required' } },
      { status: 200, headers: RESP_HEADERS },
    );
  }

  const { err, sb } = getSupabase();
  if (err || !sb) {
    return NextResponse.json(
      { ok: false, user_code, balance: 0, source: 'error', details: { message: err ?? 'init_failed' } },
      { status: 500, headers: RESP_HEADERS },
    );
  }

  const res = await fetchBalance(sb, user_code);
  return NextResponse.json(res, { status: 200, headers: RESP_HEADERS });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const user_code = pickUserCode(req, body);
  if (!user_code) {
    return NextResponse.json(
      { ok: false, user_code: null, balance: 0, source: 'error', details: { message: 'user_code required' } },
      { status: 200, headers: RESP_HEADERS },
    );
  }

  const { err, sb } = getSupabase();
  if (err || !sb) {
    return NextResponse.json(
      { ok: false, user_code, balance: 0, source: 'error', details: { message: err ?? 'init_failed' } },
      { status: 500, headers: RESP_HEADERS },
    );
  }

  const res = await fetchBalance(sb, user_code);
  return NextResponse.json(res, { status: 200, headers: RESP_HEADERS });
}
