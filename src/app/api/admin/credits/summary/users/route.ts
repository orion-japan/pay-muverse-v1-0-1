// src/app/api/admin/credits/summary/users/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
const j = (data: any, status = 200) => NextResponse.json(data, { status });

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const group_by = (searchParams.get('group_by') || 'plan_status').trim();
  const value = (searchParams.get('value') || '').trim();
  const limit = Math.min(Number(searchParams.get('limit') || 100), 500);
  const offset = Math.max(Number(searchParams.get('offset') || 0), 0);

  if (!['plan_status','plan','click_type'].includes(group_by)) {
    return j({ error: 'unsupported_group_by' }, 400);
  }
  if (!value) return j({ items: [], total: 0 });

  const selectExpr =
    'user_code,click_email,credit_balance,plan_status,plan,click_type';

  const { data, error, count } = await (sb.from('users') as any)
    .select(selectExpr, { count: 'exact' })
    .eq(group_by as any, value)
    .order('credit_balance', { ascending: true })
    .range(offset, offset + limit - 1);

  if (error) return j({ error: 'fetch_failed', detail: error.message }, 500);
  return j({ items: data ?? [], total: count ?? 0, group_by, value, limit, offset });
}
