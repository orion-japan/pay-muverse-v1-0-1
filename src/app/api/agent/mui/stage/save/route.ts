import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      user_code, seed_id, sub_id,
      partner_detail, tone, next_step,
      currentQ, depthStage, phase, self_accept
    } = body;

    if (!user_code || !seed_id || !sub_id || !partner_detail || !tone || !next_step) {
      return NextResponse.json({ ok:false, error:"missing params" }, { status: 400 });
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE!;
    if (!url || !key) {
      return NextResponse.json({ ok:false, error:"SUPABASE env missing" }, { status: 500 });
    }

    // 1) Stage追記（fn_q_append_stage）
    const rpcRes = await fetch(`${url}/rest/v1/rpc/fn_q_append_stage`, {
      method: "POST",
      headers: {
        "apikey": key,
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({
        p_user_code: user_code,
        p_seed_id: seed_id,
        p_sub_id: sub_id,
        p_currentQ: currentQ ?? null,
        p_depthStage: depthStage ?? null,
        p_phase: phase ?? null,
        p_self_accept: self_accept ?? null,
        p_next_step: next_step,
        p_tone: tone,
        p_source_type: `mui_${sub_id}`,
        p_source_id: null
      })
    });

    if (!rpcRes.ok) {
      const err = await rpcRes.text();
      return NextResponse.json({ ok:false, error: err }, { status: 500 });
    }

    // 2) 直後の最新（v_q_case_quartet）を返す
    const viewRes = await fetch(
      `${url}/rest/v1/v_q_case_quartet?seed_id=eq.${encodeURIComponent(seed_id)}`,
      {
        headers: {
          "apikey": key,
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        cache: "no-store"
      }
    );
    const rows = await viewRes.json();
    return NextResponse.json({ ok:true, seed_id, quartet: rows?.[0] ?? null });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:String(e?.message||e) }, { status: 500 });
  }
}
