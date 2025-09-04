import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function POST(req: NextRequest) {
  try {
    const { id, is_active } = await req.json();
    if (!id || typeof is_active !== "boolean") {
      return NextResponse.json({ ok:false, error:"missing: id/is_active" }, { status:400 });
    }
    const { data, error } = await supabaseAdmin
      .from("credit_promotions")
      .update({ is_active })
      .eq("id", id)
      .select("*").single();
    if (error) throw error;
    return NextResponse.json({ ok:true, promo:data });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:e.message ?? "unknown" }, { status:500 });
  }
}
