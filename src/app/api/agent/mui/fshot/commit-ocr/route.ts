export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function json(d:any, s=200){ return new NextResponse(JSON.stringify(d), {status:s, headers:{ "content-type":"application/json; charset=utf-8"}}); }

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(()=> ({}));
    const session_id = String(b?.session_id || "");
    const user_code  = String(b?.user_code || "DEMO");
    const blocks     = Array.isArray(b?.blocks) ? b.blocks : [];

    if (!session_id) return json({ ok:false, error:"missing session_id" }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth:{ persistSession:false }});

    // 既存の ocr に追記（単純結合）
    const { data: row, error: e1 } = await sb.from("mu_fshot_sessions")
      .select("ocr").eq("id", session_id).maybeSingle();
    if (e1) return json({ ok:false, error: e1.message }, 500);

    const cur: any[] = Array.isArray(row?.ocr) ? row!.ocr : [];
    const appended = cur.concat(blocks.map((x:any) => ({
      page_index: x.page_index ?? 0,
      block_index: x.block_index ?? 0,
      text_raw: String(x.text_raw || "").slice(0, 2000),
      conf: typeof x.conf === "number" ? x.conf : null,
      x: x.x ?? 0, y: x.y ?? 0, w: x.w ?? 1, h: x.h ?? 1,
    })));

    const { error: e2 } = await sb.from("mu_fshot_sessions").update({
      ocr: appended, updated_at: new Date().toISOString()
    }).eq("id", session_id);
    if (e2) return json({ ok:false, error: e2.message }, 500);

    return json({ ok:true, blocks: appended.length });
  } catch (e:any) {
    return json({ ok:false, error:String(e?.message ?? e) }, 500);
  }
}
