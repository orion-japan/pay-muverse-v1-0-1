// src/app/api/admin/telemetry/list/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { hours = 24, kind = '', path = '', limit = 200 } = await req.json() || {};
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-only
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const h = Math.min(Math.max(Number(hours), 1), 168);
    const sinceIso = new Date(Date.now() - h*60*60*1000).toISOString();
    const lim = Math.min(Math.max(Number(limit), 50), 1000);

    let q = sb
      .from('telemetry_event')
      .select(`
        id, created_at, kind, path, status, latency_ms, note, session_id,
        telemetry_session:telemetry_session(uid,user_code,ua)
      `)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(lim);

    if (kind) q = q.eq('kind', kind);
    if (path) q = q.ilike('path', `%${path}%`);

    const { data, error } = await q;
    if (error) return NextResponse.json({ ok:false, error:error.message }, { status: 500 });
    return NextResponse.json({ ok:true, rows:data });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || 'error' }, { status: 500 });
  }
}
