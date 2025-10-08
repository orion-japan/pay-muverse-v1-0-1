export const runtime = 'nodejs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function mustEnv(n:string){ const v=process.env[n]; if(!v) throw new Error(`Missing ${n}`); return v; }
const supa = createClient(mustEnv('NEXT_PUBLIC_SUPABASE_URL'), mustEnv('SUPABASE_SERVICE_ROLE_KEY'));

export async function POST(req: NextRequest) {
  const b = await req.json() as {
    user_code: string;
    seed_id: string;
    sub_id: 'stage1-1'|'stage1-2'|'stage1-3'|'stage2-1'|'stage2-2'|'stage2-3'|'stage3-1'|'stage3-2'|'stage3-3'|'stage4-1'|'stage4-2'|'stage4-3';
    phase: 'Inner'|'Outer'|'Mixed';
    depth_stage: string;            // R3 等
    q_current: 'Q1'|'Q2'|'Q3'|'Q4'|'Q5';
    next_step: string;              // content.ts の nextStep をそのまま
    result?: any;                   // 各ステップのJSON出力
    tone?: any;                     // extra.tone 相当（phase/layer18/q_current/guardrails等）
  };

  // 1) 関数（粗い sub_id = stage1..4）へ
  const coarse = b.sub_id.split('-')[0]; // 'stage1'
  const { error: e1 } = await supa.rpc('fn_q_append_stage', {
    p_user_code: b.user_code,
    p_seed_id: b.seed_id,
    p_sub_id: coarse,
    p_currentq: b.q_current,
    p_depthstage: b.depth_stage,
    p_phase: b.phase,
    p_self_accept: 0.6,               // 任意（0..1）。UIにあれば渡す
    p_next_step: b.next_step,
    p_tone: b.tone ?? { phase: b.phase, q_current: b.q_current, guardrails: ['断定禁止','選択肢は2つ','行動は1つ'] }
  });
  if (e1) return NextResponse.json({ ok:false, error:e1.message }, { status:500 });

  // 2) 詳細（細い sub_id と result）は別テーブルへ（一覧用）
  const { error: e2 } = await supa.from('mui_stage_logs').insert({
    user_code: b.user_code,
    seed_id: b.seed_id,
    sub_id: b.sub_id,              // 'stage2-3' など
    result: b.result ?? null       // 各ステップJSONをそのまま
  });
  if (e2) return NextResponse.json({ ok:false, error:e2.message }, { status:500 });

  return NextResponse.json({ ok:true });
}
