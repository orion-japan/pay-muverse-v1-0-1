// src/app/api/admin/invites/list/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const limit = Math.min(Math.max(Number(body.limit || 50), 1), 200);

    const { data, error } = await supabaseAdmin
      .from('invite_links')
      .select(
        'id, short_code, destination_type, destination_url, ref, rcode, mcode, media_code, label, memo, is_active, click_count, created_by, created_at, updated_at',
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    const origin = process.env.NEXT_PUBLIC_JOIN_BASE_URL || 'https://join.muverse.jp';
    const base = origin.replace(/\/+$/, '');
    return NextResponse.json({
      ok: true,
      rows: (data || []).map((row: any) => ({ ...row, short_url: `${base}/i/${row.short_code}` })),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}
