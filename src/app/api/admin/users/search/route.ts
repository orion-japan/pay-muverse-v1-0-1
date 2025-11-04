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
  const q = (searchParams.get('q') || '').trim();
  const exact = searchParams.get('exact') === '1';
  if (!q) return j({ items: [] });

  let data: any[] = [];
  if (exact) {
    const { data: d1 } = await sb
      .from('users')
      .select('user_code, click_email, credit_balance')
      .eq('user_code', q)
      .limit(1);
    if (d1?.length) data = d1;
  } else {
    const { data: d1 } = await sb
      .from('users')
      .select('user_code, click_email, credit_balance')
      .eq('user_code', q)
      .limit(1);
    const { data: d2 } = await sb
      .from('users')
      .select('user_code, click_email, credit_balance')
      .ilike('click_email', `%${q}%`)
      .limit(10);
    data = [...(d1 || []), ...(d2 || [])];
  }

  return j({ items: data });
}
