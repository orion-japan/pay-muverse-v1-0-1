export const runtime = 'nodejs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/* ===== Utility ===== */
function mustEnv(n: string) {
  const v = process.env[n];
  if (!v) throw new Error(`Missing ${n}`);
  return v;
}

/* ===== Supabase ===== */
const supa = createClient(
  mustEnv('NEXT_PUBLIC_SUPABASE_URL'),
  mustEnv('SUPABASE_SERVICE_ROLE_KEY')
);

/**
 * GET /api/agent/mui/stage1/result?conv=MU-xxxx
 * 返却:
 * {
 *   ok: true,
 *   result: {
 *     q_code: "Q1〜Q5",
 *     summary: "...",
 *     bullets: [...],
 *     advice: [...],
 *     next_actions: [...],
 *     ls7: { top: "...", hits: [...] }
 *   }
 * }
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const conv = searchParams.get('conv')?.trim() || '';
    if (!conv) {
      return NextResponse.json({ ok: false, error: 'conv is required' }, { status: 400 });
    }

    /* ---- DBからフェーズ1結果を取得 ---- */
    const { data, error } = await supa
      .from('mui_phase1_results')
      .select('result_json')
      .eq('conv_code', conv)
      .maybeSingle();

    if (error) throw error;

    if (!data?.result_json) {
      return NextResponse.json({ ok: true, result: null });
    }

    /* ---- JSON整形（安全にパース） ---- */
    let parsed: any = null;
    try {
      parsed =
        typeof data.result_json === 'string'
          ? JSON.parse(data.result_json)
          : data.result_json;
    } catch {
      parsed = data.result_json;
    }

    /* ---- LS7とQコード補完 ---- */
    const q_code = parsed?.q_code || 'Q3';
    const ls7 = parsed?.ls7 || null;

    const normalized = {
      q_code,
      summary: parsed?.summary || '',
      bullets: parsed?.bullets || [],
      advice: parsed?.advice || [],
      next_actions: parsed?.next_actions || [],
      ls7,
    };

    return NextResponse.json({ ok: true, result: normalized });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
