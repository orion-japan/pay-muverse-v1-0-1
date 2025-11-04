import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function GET(req: NextRequest) {
  try {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) return NextResponse.json({ ok: false, error: 'missing: code' }, { status: 400 });
    const { data, error } = await supabaseAdmin
      .from('groups')
      .select('id, group_code, name')
      .eq('group_code', code)
      .maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
    return NextResponse.json({ ok: true, group: data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message ?? 'unknown' }, { status: 500 });
  }
}
