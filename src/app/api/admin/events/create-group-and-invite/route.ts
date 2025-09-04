import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

function generateInviteCode(prefix = "MU"): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let body = "";
  for (let i = 0; i < 6; i++) body += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${body}`;
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const {
      group_code,
      leader_user_code,
      group_name,
      group_description = null,
      invite_max_uses = 1000,
      invite_expires_at = null,
      invite_notes = "event",
      // ★ 追加
      campaign_type = "bonus-credit",
      bonus_credit = 45,
    } = b ?? {};

    if (!group_code || !leader_user_code || !group_name) {
      return NextResponse.json({ ok:false, error:"missing: group_code/leader_user_code/group_name" }, { status:400 });
    }

    // 1) groups upsert
    const { data: g0, error: gselErr } = await supabaseAdmin
      .from("groups").select("id").eq("group_code", group_code).maybeSingle();
    if (gselErr) throw gselErr;

    let group_id: string;
    if (g0?.id) {
      group_id = g0.id;
    } else {
      const { data: gins, error: ginsErr } = await supabaseAdmin
        .from("groups")
        .insert({ group_code, leader_user_code, name: group_name, description: group_description ?? `event group ${group_code}` })
        .select("id").single();
      if (ginsErr) throw ginsErr;
      group_id = gins.id;

      const { error: gmErr } = await supabaseAdmin
        .from("group_members").upsert({ group_id, user_code: leader_user_code, role: "leader" });
      if (gmErr) throw gmErr;
    }

    // 2) 招待コードを生成（1イベント=1コード想定）
    let code = "";
    for (let i = 0; i < 5; i++) {
      const cand = generateInviteCode("MU");
      const { data: exists, error: e1 } = await supabaseAdmin
        .from("invite_codes").select("id").eq("code", cand).maybeSingle();
      if (e1) throw e1;
      if (!exists) { code = cand; break; }
    }
    if (!code) return NextResponse.json({ ok:false, error:"code generation failed" }, { status:500 });

    const { data: inv, error: ie } = await supabaseAdmin
      .from("invite_codes")
      .insert({
        code,
        creator_user_code: leader_user_code,
        group_id,
        max_uses: invite_max_uses,
        expires_at: invite_expires_at,
        notes: invite_notes,
        is_active: true,
        // ★ 追加
        campaign_type,
        bonus_credit: Math.max(0, parseInt(String(bonus_credit || 0), 10)),
      })
      .select("*").single();
    if (ie) throw ie;

    const rcode = leader_user_code;
    const mcode = group_code;
    const eve   = inv.code;

    return NextResponse.json({
      ok: true,
      group: { id: group_id, group_code, name: group_name },
      invite: inv,
      rcode, mcode, eve,
      example_link: `https://join.muverse.jp/register?ref=<app_code>&rcode=${rcode}&mcode=${mcode}&eve=${eve}`,
    });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error:e?.message ?? "unknown error" }, { status:500 });
  }
}
