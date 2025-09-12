// src/app/api/admin/events/create-group-and-invite/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

/** ランダム招待コード生成: 例 MU-7GJ3KQ */
function generateInviteCode(prefix = "MU"): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let body = "";
  for (let i = 0; i < 6; i++) body += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${body}`;
}

/** 入力用イベントコードの簡易バリデーション（空は許可） */
function isValidEventCode(s?: string | null) {
  if (!s) return true; // 空はOK（自動採番）
  return /^[A-Za-z0-9-]{4,32}$/.test(s);
}

/** デフォルトで1か月後のJST → UTC文字列 */
function defaultExpireAt(): string {
  const d = new Date();
  d.setMonth(d.getMonth() + 1); // 1か月後
  return d.toISOString(); // UTCで保存（DB側は timestamptz なのでOK）
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
      invite_expires_at,
      invite_notes = "event",
      campaign_type = "bonus-credit",
      bonus_credit = 45,
      event_code,
    } = b ?? {};

    // 必須チェック
    if (!group_code || !leader_user_code || !group_name) {
      return NextResponse.json(
        { ok: false, error: "missing: group_code/leader_user_code/group_name" },
        { status: 400 }
      );
    }

    // イベントコードの形式チェック
    if (!isValidEventCode(event_code)) {
      return NextResponse.json(
        { ok: false, error: "invalid event_code: use 4-32 chars [A-Za-z0-9-] or leave empty" },
        { status: 400 }
      );
    }

    /** 1) groups upsert */
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

      // リーダーをメンバー登録
      const { error: gmErr } = await supabaseAdmin
        .from("group_members")
        .upsert({ group_id, user_code: leader_user_code, role: "leader" });
      if (gmErr) throw gmErr;
    }

    /** 2) 招待コード（= eve）を決定 */
    let codeToUse: string | null = null;

    if (event_code) {
      const { data: dup, error: dupErr } = await supabaseAdmin
        .from("invite_codes")
        .select("id")
        .eq("code", event_code)
        .maybeSingle();
      if (dupErr) throw dupErr;
      if (dup) {
        return NextResponse.json(
          { ok: false, error: "このイベントコードは既に使われています（重複）" },
          { status: 409 }
        );
      }
      codeToUse = event_code;
    } else {
      for (let i = 0; i < 5; i++) {
        const cand = generateInviteCode("MU");
        const { data: exists, error: e1 } = await supabaseAdmin
          .from("invite_codes")
          .select("id")
          .eq("code", cand)
          .maybeSingle();
        if (e1) throw e1;
        if (!exists) {
          codeToUse = cand;
          break;
        }
      }
      if (!codeToUse) {
        return NextResponse.json({ ok: false, error: "code generation failed" }, { status: 500 });
      }
    }

    /** 3) invite_codes に作成 */
    const { data: inv, error: ie } = await supabaseAdmin
      .from("invite_codes")
      .insert({
        code: codeToUse,
        creator_user_code: leader_user_code,
        issuer_code: leader_user_code,
        group_id,
        max_uses: invite_max_uses,
        expires_at: invite_expires_at || defaultExpireAt(), // ★ デフォルト1か月後
        notes: invite_notes,
        is_active: true,
        campaign_type,
        bonus_credit: Math.max(0, parseInt(String(bonus_credit ?? 0), 10)),
      })
      .select("*")
      .single();
    if (ie) throw ie;

    /** 4) レスポンス */
    const rcode = leader_user_code;
    const mcode = group_code;
    const eve = inv.code;

    return NextResponse.json({
      ok: true,
      group: { id: group_id, group_code, name: group_name },
      invite: inv,
      rcode,
      mcode,
      eve,
      example_link: `https://join.muverse.jp/register?ref=<app_code>&rcode=${rcode}&mcode=${mcode}&eve=${eve}`,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? "unknown error" }, { status: 500 });
  }
}
