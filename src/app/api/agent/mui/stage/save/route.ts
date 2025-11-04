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
  mustEnv('SUPABASE_SERVICE_ROLE_KEY'),
);

/**
 * POST /api/agent/mui/stage/save
 * 入力：
 * {
 *   user_code: string,
 *   seed_id: string,
 *   sub_id: "stage1-1"|"stage1-2"|...|"stage4-3",
 *   phase: "Inner"|"Outer"|"Mixed",
 *   depth_stage: string,
 *   q_current: "Q1"|"Q2"|"Q3"|"Q4"|"Q5",
 *   next_step: string,
 *   result?: any,
 *   tone?: any
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as {
      user_code: string;
      seed_id: string;
      sub_id:
        | 'stage1-1'
        | 'stage1-2'
        | 'stage1-3'
        | 'stage2-1'
        | 'stage2-2'
        | 'stage2-3'
        | 'stage3-1'
        | 'stage3-2'
        | 'stage3-3'
        | 'stage4-1'
        | 'stage4-2'
        | 'stage4-3';
      phase: 'Inner' | 'Outer' | 'Mixed';
      depth_stage: string;
      q_current: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
      next_step: string;
      result?: any;
      tone?: any;
    };

    if (!b.user_code || !b.seed_id || !b.sub_id) {
      return NextResponse.json({ ok: false, error: 'Missing required fields.' }, { status: 400 });
    }

    /* ---- 1) RPC呼び出し (coarse stage append) ---- */
    const coarse = b.sub_id.split('-')[0]; // 'stage1' など
    const { error: e1 } = await supa.rpc('fn_q_append_stage', {
      p_user_code: b.user_code,
      p_seed_id: b.seed_id,
      p_sub_id: coarse,
      p_currentq: b.q_current,
      p_depthstage: b.depth_stage,
      p_phase: b.phase,
      p_self_accept: 0.6,
      p_next_step: b.next_step,
      p_tone: b.tone ?? {
        phase: b.phase,
        q_current: b.q_current,
        guardrails: ['断定禁止', '選択肢は2つ', '行動は1つ'],
      },
    });

    if (e1) {
      console.error('RPC Error:', e1);
      return NextResponse.json({ ok: false, error: e1.message }, { status: 500 });
    }

    /* ---- 2) mui_stage_logsへ挿入 ---- */
    const { error: e2 } = await supa.from('mui_stage_logs').insert({
      user_code: b.user_code,
      seed_id: b.seed_id,
      sub_id: b.sub_id,
      result: b.result ?? null,
    });

    if (e2) {
      console.error('Insert Error:', e2);
      return NextResponse.json({ ok: false, error: e2.message }, { status: 500 });
    }

    /* ---- 3) Qコード解析結果をmui_phase1_resultsに格納（LS7含む場合） ---- */
    if (b.result?.q_code || b.result?.ls7) {
      const { error: e3 } = await supa.from('mui_phase1_results').upsert({
        conv_code: b.seed_id,
        result_json: b.result,
        updated_at: new Date().toISOString(),
      });

      if (e3) {
        console.error('Upsert Error (mui_phase1_results):', e3);
        return NextResponse.json({ ok: false, error: e3.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('Save API Error:', e);
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
