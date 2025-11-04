// src/app/api/agent/iros/userinfo/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    },
  });

export async function OPTIONS() {
  return json({ ok: true });
}

export async function GET(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);

    console.log('[IROS/UserInfo] authz =', authz);

    if (!authz.ok)
      return json({ ok: false, error: authz.error || 'unauthorized' }, authz.status || 401);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    // user_code を確定
    const userCode =
      (typeof authz.user === 'string' && authz.user) ||
      (typeof (authz.user as any)?.user_code === 'string' &&
        (authz.user as any).user_code) ||
      (authz as any)?.userCode ||
      (authz as any)?.jwt?.sub ||
      '';

    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    // users テーブルから必要最小フィールドを取得
    const { data, error } = await sb
      .from('users')
      .select('id, user_code, click_username, click_type, sofia_credit')
      .eq('user_code', userCode)
      .maybeSingle();

    if (error) {
      console.error('[IROS/UserInfo] DB error:', error.message);
      return json({ ok: false, error: 'db_error', detail: error.message }, 500);
    }

    // フォールバックを含めてUIが期待する形に整形
    const user = !data
      ? {
          id: 'me',
          name: 'You',
          userType: 'member',
          credits: 0,
        }
      : {
          id: String(data.id ?? 'me'),
          name: String(data.click_username ?? 'You'),
          userType: String(data.click_type ?? 'member'),
          credits: Number(data.sofia_credit ?? 0),
        };

    return json({ ok: true, user });
  } catch (e: any) {
    console.error('[IROS/UserInfo] Fatal error:', e);
    return json(
      { ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) },
      500,
    );
  }
}
