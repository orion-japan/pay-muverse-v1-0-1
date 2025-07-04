// src/app/api/logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';

export async function GET(req: NextRequest) {
  const searchParams = req.nextUrl.searchParams;

  const ip = searchParams.get('ip') || '';
  const phone = searchParams.get('phone') || '';

  let query = supabase.from('register_logs').select('*');

  if (ip) {
    query = query.ilike('ip_address', `%${ip}%`);
  }
  if (phone) {
    query = query.ilike('phone_number', `%${phone}%`);
  }

  const { data, error } = await query.order('created_at', { ascending: false });

  if (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }

  return NextResponse.json({ logs: data });
}
