import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// シンプルなコード生成
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
      group_code,                // 例: "913EVENT"
      leader_user_code,          // 例: "336699"（運営ユーザーでもOK）
      group_name,                // 例: "9/13 Meetup"
      group_description = null,  // 任意
      invite_max_uses = 1000,    // イベント規模に応じて
      invite_expires_at = null,  // 例: "2025-09-13T23:59:59+09:00"
      invite_notes = "event",
    } = b ?? {};

    if (!group_code || !leader_user_code || !group_name) {
      return NextResponse.json({ ok:false, error:"missing: group_code/leader_user_code/group_name" }, { status:400 });
    }

    // 1) groups upsert
    const { data: g0, error: gselErr } = await supabaseAdmin
      .from("groups")
      .select("id")
      .eq("group_code", group_code)
      .maybeSingle();
    if (gselErr) throw gselErr;

    let group_id: string;
    if (g0?.id) {
      group_id = g0.id;
    } else {
      const { data: gins, error: ginsErr } = await supabaseAdmin
        .from("groups")
        .insert({
          group_code,
          leader_user_code,
          name: group_name,
          description: group_description ?? `event group ${group_code}`,
        })
        .select("id")
        .single();
      if (ginsErr) throw ginsErr;
      group_id = gins.id;

      // リーダー本人をメンバー表に追加（role=leader）
      const { error: gmErr } = await supabaseAdmin
        .from("group_members")
        .upsert({ group_id, user_code: leader_user_code, role: "leader" });
      if (gmErr) throw gmErr;
    }

    // 2) イベント招待コード（group_id付き）を生成
    let code = "";
    for (let i = 0; i < 5; i++) {
      const cand = generateInviteCode("MU");
      const { data: exists, error: e1 } = await supabaseAdmin
        .from("invite_codes")
        .select("id")
        .eq("code", cand)
        .maybeSingle();
      if (e1) throw e1;
      if (!exists) { code = cand; break; }
    }
    if (!code) return NextResponse.json({ ok:false, error:"code generation failed" }, { status:500 });

    const { data: inv, error: ie } = await supabaseAdmin
      .from("invite_codes")
      .insert({
        code,
        creator_user_code: leader_user_code,   // 運営アカウント等
        group_id,                               // ← イベント用グループに紐付け！
        max_uses: invite_max_uses,
        expires_at: invite_expires_at,
        notes: invite_notes,
        is_active: true,
      })
      .select("*")
      .single();
    if (ie) throw ie;

    return NextResponse.json({
      ok: true,
      group: { id: group_id, group_code, name: group_name },
      invite: inv,
      // 使うURL例（必要に応じて変更）
      example_link: `/register?ref=${inv.code}&group=${group_code}`,
    });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error:e?.message ?? "unknown error" }, { status:500 });
  }
}
