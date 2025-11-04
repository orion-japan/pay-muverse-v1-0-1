export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
const j = (data: any, status = 200) => NextResponse.json(data, { status });

export async function GET(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) return j({ error: z.error }, z.status);
  if (!z.allowed) return j({ error: 'forbidden' }, 403);

  // 管理者チェック
  const admin = z.userCode!;
  const { data: me } = await sb
    .from('users')
    .select('plan_status, click_type')
    .eq('user_code', admin)
    .single();
  const isAdmin = !!(
    me &&
    ((me as any).plan_status === 'admin' ||
      (me as any).plan_status === 'master' ||
      (me as any).click_type === 'admin')
  );
  if (!isAdmin) return j({ error: 'not_admin' }, 403);

  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || '';
  const limit = Math.min(Number(searchParams.get('limit') || 50), 200);
  if (!user_code) return j({ error: 'user_code_required' }, 400);

  const { data, error } = await sb
    .from('credit_transactions')
    .select('id, user_code, user_id, delta, reason, idempotency_key, created_at')
    .eq('user_code', user_code)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return j({ error: 'fetch_failed', detail: error.message }, 500);
  return j({ items: data ?? [] });
}
