import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { invite_id, is_active } = await req.json();
    if (!invite_id || typeof is_active !== "boolean") {
      return NextResponse.json({ ok:false, error:"missing invite_id/is_active" }, { status:400 });
    }
    const { error } = await supabaseAdmin
      .from("invite_codes")
      .update({ is_active })
      .eq("id", invite_id);
    if (error) throw error;
    return NextResponse.json({ ok:true });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:e?.message || "error" }, { status:500 });
  }
}
