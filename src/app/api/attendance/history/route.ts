export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const user_code = searchParams.get('user_code') || '';
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    if (!user_code || !from || !to) {
      return NextResponse.json({ ok: false, error: 'MISSING_PARAMS' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc('attendance_history', {
      p_user_code: user_code,
      p_from: from,
      p_to: to,
    });
    if (error) throw error;

    return NextResponse.json(Array.isArray(data) ? data : []);
  } catch (e: any) {
    console.error('[attendance/history]', e);
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 });
  }
}
