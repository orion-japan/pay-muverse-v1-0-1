import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function GET(req: NextRequest) {
  try {
    // groups と invite_codes（1イベント=1コード前提）を結合して返す
    const { data, error } = await supabaseAdmin
      .from("groups")
      .select(`
        id, group_code, name, leader_user_code,
        invite_codes:invite_codes!invite_codes_group_id_fkey (
          id, code, max_uses, expires_at, is_active, used_count
        )
      `);
    if (error) throw error;

    // used_count がテーブルに無い場合は 0 として返す
    const rows = (data || []).map(g => {
      const inv = (g as any).invite_codes?.[0] ?? null;
      return {
        group_code: g.group_code,
        group_name: g.name,
        rcode: g.leader_user_code,
        mcode: g.group_code,
        eve: inv?.code ?? null,
        max_uses: inv?.max_uses ?? null,
        used_count: inv?.used_count ?? 0,
        expires_at: inv?.expires_at ?? null,
        is_active: inv?.is_active ?? false,
        invite_id: inv?.id ?? null,
      };
    });

    return NextResponse.json({ ok: true, rows });
  } catch (e: any) {
    return NextResponse.json({ ok:false, error: e?.message || "error" }, { status: 500 });
  }
}
