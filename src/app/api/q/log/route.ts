// src/app/api/q/log/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE, normalizeAuthz } from '@/lib/authz';

export async function POST(req: NextRequest) {
  try {
    const authzRaw = await verifyFirebaseAndAuthorize(req);
    const { user, error } = normalizeAuthz(authzRaw);
    if (error || !user) {
      return NextResponse.json({ error: String(error ?? 'Unauthorized') }, { status: 401 });
    }

    const body = await req.json();
    const { source_type, intent, current_q, depth_stage, ts } = body || {};
    if (!source_type || !current_q || !depth_stage) {
      return NextResponse.json({ ok: false, error: 'missing fields' }, { status: 400 });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const eventTime = ts ? new Date(ts) : new Date();

    const { error: ierr } = await supabase.from('q_code_logs').insert({
      user_code: user.user_code,
      source_type,
      intent,
      q_code: {
        ts: Math.floor(eventTime.getTime() / 1000),
        currentQ: current_q,
        depthStage: depth_stage,
      },
      created_at: eventTime.toISOString(),
    });

    if (ierr) throw ierr;
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message ?? e) }, { status: 500 });
  }
}
