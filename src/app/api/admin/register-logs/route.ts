// src/app/api/admin/register-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const { ip = '', phone = '', limit = 200 } = await req.json() || {};
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-only
    const sb = createClient(url, key, { auth: { persistSession: false } });

    const lim = Math.min(Math.max(Number(limit), 50), 2000);

    let q = sb
      .from('register_logs') // ← あなたのテーブル名に合わせる
      .select('id, ip_address, phone_number, referral_code, created_at')
      .order('created_at', { ascending: false })
      .limit(lim);

    if (ip)    q = q.ilike('ip_address', `%${ip}%`);
    if (phone) q = q.ilike('phone_number', `%${phone}%`);

    const { data, error } = await q;
    if (error) return NextResponse.json({ ok:false, error:error.message }, { status: 500 });
    return NextResponse.json({ ok:true, rows:data });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error: e?.message || 'error' }, { status: 500 });
  }
}
