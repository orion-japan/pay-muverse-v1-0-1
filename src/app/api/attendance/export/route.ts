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
      return new NextResponse('MISSING_PARAMS', { status: 400 });
    }

    const { data, error } = await supabaseAdmin.rpc('attendance_history', {
      p_user_code: user_code,
      p_from: from,
      p_to: to,
    });
    if (error) throw error;

    const rows: Array<{ date: string; event_id: string }> = Array.isArray(data) ? data : [];
    const header = 'date,event_id';
    const body = rows.map(r => `${r.date},${r.event_id}`).join('\n');
    const csv = `${header}\n${body}\n`;

    return new NextResponse(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="attendance_${user_code}_${from}_${to}.csv"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (e: any) {
    console.error('[attendance/export]', e);
    return new NextResponse('INTERNAL', { status: 500 });
  }
}
