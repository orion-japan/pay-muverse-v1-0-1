// src/app/api/admin/credits/series/route.ts
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
  const { data: me } = await supa.from('users')
    .select('is_super_admin, user_code').eq('user_code', z.userCode).maybeSingle();
  if (!me?.is_super_admin) return json({ error: 'admin_only' }, 403);

  const { searchParams } = new URL(req.url);
  const user_code = searchParams.get('user_code') || undefined;
  const days = Math.max(1, Math.min(Number(searchParams.get('days')||'30'), 365));

  // v_credit_daily を使って直近N日を取得
  let q = supa.from('v_credit_daily')
    .select('user_code, day, spent, granted, net_day, running_net')
    .order('day', { ascending: true });
  if (user_code) q = q.eq('user_code', user_code);
  // サーバ側で where 条件（直近N日）
  const since = new Date(); since.setDate(since.getDate()-days);
  q = q.gte('day', since.toISOString().slice(0,10));

  const { data, error } = await q;
  if (error) return json({ error: error.message }, 500);

  return json({ series: data });
}
