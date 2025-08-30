export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function json(status: number, body: any) {
  return NextResponse.json(body, { status });
}

export async function POST(req: NextRequest) {
  try {
    const { user_code, event_id, at } = await req.json().catch(() => ({}));
    if (!user_code || !event_id) return json(400, { ok: false, error: 'MISSING_PARAMS' });
    if (!['kyomeikai', 'ainori'].includes(String(event_id))) {
      return json(400, { ok: false, error: 'BAD_EVENT' });
    }

    const { data, error } = await supabaseAdmin.rpc('attendance_checkin', {
      p_user_code: String(user_code),
      p_event_id: String(event_id),
      p_at: at ? new Date(at).toISOString() : null,
    });

    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return json(200, { ok: true, ...row });
  } catch (e: any) {
    console.error('[attendance/checkin]', e);
    return json(500, { ok: false, error: e?.message || 'INTERNAL' });
  }
}
