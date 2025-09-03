// src/app/api/telemetry/collect/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const {
      kind = 'page',
      path = '',
      status = null,
      latency_ms = null,
      note = '',
      uid = null,
      user_code = null,
    } = body || {};

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; // ← Server-only
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const ua = req.headers.get('user-agent') || '';

    const { error } = await sb.from('telemetry_event').insert([{
      kind, path, status, latency_ms, note, uid, user_code, ua,
    }]);

    if (error) return NextResponse.json({ ok:false, error:error.message }, { status:500 });
    return NextResponse.json({ ok:true });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || 'error' }, { status:500 });
  }
}
