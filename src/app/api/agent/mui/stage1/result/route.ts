export const runtime = 'nodejs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function mustEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}

const supa = createClient(
  mustEnv('NEXT_PUBLIC_SUPABASE_URL'),
  mustEnv('SUPABASE_SERVICE_ROLE_KEY')
);

/**
 * GET /api/agent/mui/stage1/result?conv=MU-xxxx
 * 返却: { ok:true, result: Phase1Result | null }
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const conv = searchParams.get('conv')?.trim() || '';
    if (!conv) {
      return NextResponse.json({ ok: false, error: 'conv is required' }, { status: 400 });
    }

    const { data, error } = await supa
      .from('mui_phase1_results')
      .select('result_json')
      .eq('conv_code', conv)
      .maybeSingle();

    if (error) throw error;

    return NextResponse.json({ ok: true, result: data?.result_json ?? null });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
