import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import dayjs from 'dayjs';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const user_code = searchParams.get('user_code') || '';
    const vision_id = searchParams.get('vision_id') || '';
    const days = Math.max(1, Math.min(60, Number(searchParams.get('days') || 14)));

    if (!user_code || !vision_id) {
      return NextResponse.json({ error: 'missing params' }, { status: 400 });
    }

    const to = dayjs().format('YYYY-MM-DD');
    const from = dayjs()
      .subtract(days - 1, 'day')
      .format('YYYY-MM-DD');

    const { data, error } = await supabase
      .from('daily_checks')
      .select('check_date, progress, vision_imaged, resonance_shared')
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .gte('check_date', from)
      .lte('check_date', to)
      .order('check_date', { ascending: true });

    if (error) throw error;

    return NextResponse.json({ data });
  } catch (e: any) {
    console.error('❌ GET /daily-checks/history error:', e);
    return NextResponse.json({ error: e.message ?? 'server error' }, { status: 500 });
  }
}
