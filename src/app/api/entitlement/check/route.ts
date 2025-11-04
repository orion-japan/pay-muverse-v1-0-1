// src/app/api/entitlement/check/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function must(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const supa = createClient(must('NEXT_PUBLIC_SUPABASE_URL'), must('SUPABASE_SERVICE_ROLE_KEY'));

// 価格はUI参考用（最終価格は課金API側で再確定）
const PRICES = {
  phase2: Number(process.env.NEXT_PUBLIC_PRICE_P2 ?? 280),
  phase3: Number(process.env.NEXT_PUBLIC_PRICE_P3 ?? 980),
  phase4: Number(process.env.NEXT_PUBLIC_PRICE_P4 ?? 1980),
  bundle234: Number(process.env.NEXT_PUBLIC_PRICE_BUNDLE ?? 3180),
} as const;

/**
 * GET /api/entitlement/check
 * ヘッダorクエリに userId を渡してください。
 * 例: fetch('/api/entitlement/check', { headers: { 'x-user-id': userId } })
 *     /api/entitlement/check?userId=xxx
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = req.headers.get('x-user-id') || searchParams.get('userId') || '';
    if (!userId) {
      return NextResponse.json({ ok: false, error: 'missing_userId' }, { status: 400 });
    }

    const { data, error } = await supa
      .from('mui_entitlements')
      .select('bundle,p2,p3,p4,updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    // 権利がなければ false で返す
    const ent = {
      bundle: !!data?.bundle,
      p2: !!data?.p2,
      p3: !!data?.p3,
      p4: !!data?.p4,
      updatedAt: data?.updated_at ?? null,
    };

    // UIがそのまま表示できる形で返却
    return new NextResponse(
      JSON.stringify({
        ok: true,
        userId,
        entitlement: ent,
        prices: PRICES,
      }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          // 叩くたびに最新を返したいので no-store（必要に応じてs-maxage調整）
          'cache-control': 'no-store',
        },
      },
    );
  } catch (e) {
    console.error('[entitlement/check] error', e);
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
