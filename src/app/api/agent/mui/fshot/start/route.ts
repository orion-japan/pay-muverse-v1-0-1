export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
function sid() { return `FS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body?.user_code || "DEMO");

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false }});
    const session_id = sid();

    const { error } = await sb.from("mu_fshot_sessions").insert({
      id: session_id,
      user_code,
      status: "draft",
      images: [],
      ocr: [],
      conversation_code: null,
      updated_at: new Date().toISOString(),
    } as any);
    if (error) return json({ ok:false, error: error.message }, 500);

    return json({ ok: true, session_id });
  } catch (e: any) {
    return json({ ok:false, error: String(e?.message ?? e) }, 500);
  }
}
