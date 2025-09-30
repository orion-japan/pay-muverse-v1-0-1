export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';
import { saveQRes } from '@/lib/qcode/save';
import type { QRes } from '@/lib/qcode/types';

const json = (d:any,s=200)=>new NextResponse(JSON.stringify(d),{status:s,headers:{'Content-Type':'application/json; charset=utf-8'}});

export async function POST(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) return json({ error: z.error }, z.status);
  if (!z.allowed) return json({ error: 'forbidden' }, 403);

  const body = await req.json().catch(()=> ({}));
  const { qres, source_type, intent } = body || {};
  if (!source_type) return json({ error:'source_type required' }, 400);
  if (!qres) return json({ error:'qres required' }, 400);

  // 型最低限チェック
  const q: QRes = { ...qres, ts: qres.ts ?? new Date().toISOString() };

  await saveQRes(SUPABASE_URL!, SERVICE_ROLE!, z.userCode!, q, String(source_type), String(intent || 'chat'));
  return json({ ok:true, qres: q });
}
