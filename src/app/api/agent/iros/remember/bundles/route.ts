// src/app/api/agent/iros/remember/bundles/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, type AuthzResult } from '@/lib/authz';
import { createClient } from '@supabase/supabase-js';

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, x-user-code',
} as const;

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

type PeriodType = 'day' | 'week' | 'month';

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * authz 結果とヘッダから userCode を決定する
 * - 最優先: auth.userCode（authz.ts が claims / DB から決定したもの）
 * - 次点  : auth.user.user_code
 * - 最後  : 開発用ヘッダ x-user-code
 */
function resolveUserCode(req: NextRequest, auth: AuthzResult): string | null {
  const fromAuth =
    (auth.userCode && String(auth.userCode)) ||
    (auth.user?.user_code && String(auth.user.user_code)) ||
    null;

  const header = req.headers.get('x-user-code');
  const fromHeader =
    header && header.trim().length > 0 ? header.trim() : null;

  return fromAuth ?? fromHeader ?? null;
}

export async function GET(req: NextRequest) {
  try {
    // 1) 認証
    const auth = await verifyFirebaseAndAuthorize(req);

    if (!auth?.ok) {
      console.warn('[RememberBundles] unauthorized', {
        status: auth?.status,
        error: auth?.error,
      });
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    const userCode = resolveUserCode(req, auth);
    if (!userCode) {
      console.warn('[RememberBundles] user_code missing', {
        authUserCode: auth.userCode,
        authUser: auth.user,
      });
      return NextResponse.json(
        { ok: false, error: 'unauthorized_user_code_missing' },
        { status: 401, headers: CORS_HEADERS },
      );
    }

    const url = req.nextUrl;
    const search = url.searchParams;

    // 2) クエリパラメータ
    const periodParam = (search.get('period') || 'month').toLowerCase() as PeriodType;
    const periodType: PeriodType =
      periodParam === 'day' || periodParam === 'week' || periodParam === 'month'
        ? periodParam
        : 'month';

    const limitParam = search.get('limit');
    const limit = (() => {
      const n = limitParam ? Number(limitParam) : NaN;
      if (!Number.isFinite(n) || n <= 0) return 30;
      return Math.min(n, 100);
    })();

    const tenantId =
      (search.get('tenant_id') && search.get('tenant_id')!.trim()) || 'default';

    // 3) Supabase から取得
    const query = supabase
      .from('resonance_period_bundles')
      .select(
        [
          'id',
          'period_type',
          'period_start',
          'period_end',
          'title',
          'summary',
          'q_dominant',
          'q_stats',
          'depth_stats',
          'topics',
          'created_at',
        ].join(','),
      )
      .eq('user_code', userCode)
      .eq('tenant_id', tenantId)
      .eq('period_type', periodType)
      .order('period_start', { ascending: false })
      .limit(limit);

    const { data, error } = await query;

    if (error) {
      console.error('[RememberBundles] query failed', error);
      return NextResponse.json(
        { ok: false, error: 'query_failed', detail: error.message },
        { status: 500, headers: CORS_HEADERS },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        period_type: periodType,
        tenant_id: tenantId,
        bundles: data ?? [],
      },
      { status: 200, headers: CORS_HEADERS },
    );
  } catch (err: any) {
    console.error('[RememberBundles][GET] fatal', err);
    return NextResponse.json(
      { ok: false, error: 'internal_error', detail: err?.message ?? String(err) },
      { status: 500, headers: CORS_HEADERS },
    );
  }
}
