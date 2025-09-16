// src/app/api/admin/credits/transactions/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';

function json(data:any, init?:number|ResponseInit){
  const status = typeof init==='number'?init:(init as ResponseInit|undefined)?.['status']??200;
  const headers = new Headers(typeof init==='number'?undefined:(init as ResponseInit|undefined)?.headers);
  headers.set('Content-Type','application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data),{status,headers});
}

export async function GET(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) return json({ error: z.error }, z.status);
  if (!z.allowed) return json({ error: 'forbidden' }, 403);

  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

  // adminチェック
  const { data: me } = await supa.from('users')
    .select('is_super_admin, user_code')
    .eq('user_code', z.userCode)
    .maybeSingle();
  if (!me?.is_super_admin) return json({ error: 'admin_only' }, 403);

  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || undefined;
  const from = searchParams.get('from') || undefined;
  const to = searchParams.get('to') || undefined;
  const limit = Math.min(Number(searchParams.get('limit')||'200'), 1000);

  // v_credit_events を使う
  let q = supa.from('v_credit_events')
    .select('created_at, user_code, reason, amount, spent, granted')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (user_code) q = q.eq('user_code', user_code);
  if (from) q = q.gte('created_at', from);
  if (to) q = q.lte('created_at', to);

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  return json({ items: data });
}
