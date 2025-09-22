import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE || SUPABASE_ANON);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body?.user_code ?? '').trim();

    if (!user_code) {
      return NextResponse.json(
        { success: false, balance: 0, remaining: 0, error: 'user_code required' },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // ① users.sofia_credit を最優先
    const { data: userRow, error: userErr } = await supabase
      .from('users')
      .select('sofia_credit')
      .eq('user_code', user_code)
      .maybeSingle();

    if (!userErr && userRow && userRow.sofia_credit != null) {
      const remaining = Number(userRow.sofia_credit) || 0;
      return NextResponse.json(
        {
          success: true,
          source: 'users.sofia_credit',
          running_net: null,
          sum_delta: null,
          remaining,
          balance: remaining,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // ② フォールバック：ledger の delta 合計
    const { data: rows, error: sumErr } = await supabase
      .from('credits_ledger')
      .select('delta')
      .eq('user_code', user_code);

    if (sumErr) {
      return NextResponse.json(
        { success: false, balance: 0, remaining: 0, error: `sum failed: ${sumErr.message}` },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const sumDelta = (rows ?? []).reduce((acc, r: any) => acc + Number(r?.delta ?? 0), 0);
    // ※ あなたの運用が「delta = 付与(＋)・消費(－)」なら sumDelta が残高。
    // もし「delta が累計消費のみ（常にマイナス）」ならここは 0 固定でもOK。
    const remaining = sumDelta;

    return NextResponse.json(
      {
        success: true,
        source: 'sum_only',
        running_net: null,
        sum_delta: sumDelta,
        remaining,
        balance: remaining,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { success: false, balance: 0, remaining: 0, error: e?.message ?? 'unknown error' },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
