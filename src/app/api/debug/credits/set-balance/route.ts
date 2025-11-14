// src/app/api/debug/credits/set-balance/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization, X-User-Code, x-user-code',
} as const;

// 環境変数（存在チェックも含める）
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
if (!SUPABASE_URL) throw new Error('ENV NEXT_PUBLIC_SUPABASE_URL is missing');
if (!SUPABASE_SERVICE) throw new Error('ENV SUPABASE_SERVICE_ROLE_KEY is missing');

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

// authz から uid を拾うための最小ヘルパ（dev-uid 許可）
function isAdminLike(req: NextRequest, auth: any, targetUserCode: string | null) {
  const role = String(auth?.role || '').toLowerCase();
  const uid: string | null = (auth?.uid && String(auth.uid)) || null;
  const headerUserCode = (req.headers.get('x-user-code') || req.headers.get('X-User-Code') || '').trim();

  const roleOk = role === 'admin' || role === 'master';
  const devOk = !!uid && uid.startsWith('dev-'); // 開発運用の緩和
  const selfOk = !!headerUserCode && !!targetUserCode && headerUserCode === targetUserCode;

  return roleOk || devOk || selfOk;
}

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: CORS });
    }

    const body = await req.json().catch(() => ({}));
    const user_code = String(body?.user_code ?? '').trim();
    const valueRaw = body?.value;
    const value = typeof valueRaw === 'number' ? valueRaw : Number(valueRaw);

    if (!user_code || !Number.isFinite(value)) {
      return NextResponse.json(
        { ok: false, error: 'bad_request', detail: 'user_code and numeric value are required' },
        { status: 400, headers: CORS },
      );
    }

    // 認可（admin/master か、ヘッダの x-user-code と対象が一致、または dev-uid）
    if (!isAdminLike(req, auth, user_code)) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized', role: auth.role, me: auth.userCode ?? null },
        { status: 401, headers: CORS },
      );
    }

    // Service Role クライアント（毎リクエスト生成・セッション保持なし）
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE, { auth: { persistSession: false } });

    // before を取得
    const { data: beforeRow, error: beforeErr } = await supabase
      .from('users')
      .select('user_code, sofia_credit')
      .eq('user_code', user_code)
      .maybeSingle();

    if (beforeErr) {
      return NextResponse.json(
        { ok: false, error: 'select_failed', detail: beforeErr.message },
        { status: 500, headers: CORS },
      );
    }

    // 更新
    const { data: afterRow, error: updErr } = await supabase
      .from('users')
      .update({ sofia_credit: value })
      .eq('user_code', user_code)
      .select('user_code, sofia_credit')
      .maybeSingle();

    if (updErr) {
      return NextResponse.json(
        { ok: false, error: 'update_failed', detail: updErr.message },
        { status: 500, headers: CORS },
      );
    }
    if (!afterRow) {
      return NextResponse.json(
        { ok: false, error: 'not_found', detail: 'user not found' },
        { status: 404, headers: CORS },
      );
    }

    return NextResponse.json(
      {
        ok: true,
        before: beforeRow ?? null,
        after: afterRow,
        meta: { by: 'app/api/debug/credits/set-balance', at: new Date().toISOString() },
      },
      { status: 200, headers: { ...CORS, 'x-handler': 'app/api/debug/credits/set-balance' } },
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'internal_error', detail: e?.message ?? String(e) },
      { status: 500, headers: CORS },
    );
  }
}
