// src/app/api/admin/grant-credit/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const supabase = createClient(
  SUPABASE_URL!,
  SERVICE_ROLE!,
  { auth: { persistSession: false } }
);

function j(data: any, status = 200) {
  return NextResponse.json(data, { status });
}

export async function POST(req: NextRequest) {
  try {
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok) return j({ error: z.error }, z.status);
    if (!z.allowed) return j({ error: 'forbidden' }, 403);

    const adminUserCode = z.userCode!;

    // 呼び出し元が管理者か確認（plan_status / click_type は環境に合わせて調整）
    const { data: me, error: meErr } = await supabase
      .from('users')
      .select('plan_status, click_type')
      .eq('user_code', adminUserCode)
      .single();

    if (meErr) return j({ error: 'profile_fetch_failed', detail: meErr.message }, 500);

    const isAdminOrMaster =
      (me?.plan_status && ['admin','master'].includes(me.plan_status)) ||
      (me?.click_type && ['admin'].includes(me.click_type));

    if (!isAdminOrMaster) return j({ error: 'not_admin' }, 403);

    const body = await req.json().catch(() => ({}));
    const user_code: string = body?.user_code ?? '';
    const amount: number = Number(body?.amount ?? 0);
    const reason: string = (body?.reason ?? 'manual_grant').toString();

    if (!user_code) return j({ error: 'user_code_required' }, 400);
    if (!Number.isFinite(amount) || amount <= 0) return j({ error: 'amount_positive_required' }, 400);

    // 付与RPC（冪等にするためop_id固定生成も可）
    const op_id = body?.op_id || `manual-${Date.now()}-${user_code}`;

    const { error: rpcErr } = await supabase.rpc('grant_credit_by_user_code', {
      p_user_code: user_code,
      p_amount: amount,
      p_reason: reason,
      p_op_id: op_id,
    });

    if (rpcErr) return j({ error: 'grant_failed', detail: rpcErr.message }, 500);

    // 最新残高
    const { data: after } = await supabase
      .from('users')
      .select('credit_balance')
      .eq('user_code', user_code)
      .single();

    return j({ ok: true, op_id, credit_balance: after?.credit_balance ?? null });
  } catch (e: any) {
    return j({ error: 'unhandled', detail: String(e?.message ?? e) }, 500);
  }
}
