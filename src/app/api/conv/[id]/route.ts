// src/app/api/conv/[id]/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function sb() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

const TABLE = "conversations";

// URL: /api/conv/:id
function extractIdFromUrl(req: NextRequest) {
  const segs = req.nextUrl.pathname.split("/");
  const i = segs.indexOf("conv");
  return i >= 0 ? segs[i + 1] : undefined;
}

export async function PATCH(req: NextRequest) {
  try {
    const id = extractIdFromUrl(req);
    if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

    const { title } = (await req.json()) as { title?: string };
    const t = title?.trim();
    if (!t) return NextResponse.json({ error: "title is required" }, { status: 400 });

    const client = sb();
    const { data, error } = await client
      .from(TABLE)
      .update({ title: t, updated_at: new Date().toISOString() })
      .eq("conversation_code", id)
      .select("conversation_code, title")
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

    return NextResponse.json({ id: data.conversation_code, title: data.title });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "PATCH failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = extractIdFromUrl(req);
    if (!id) return NextResponse.json({ error: "missing id" }, { status: 400 });

    const client = sb();
    const { error } = await client.from(TABLE).delete().eq("conversation_code", id);
    if (error) throw error;

    return NextResponse.json({ ok: true, id });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "DELETE failed" }, { status: 500 });
  }
}
