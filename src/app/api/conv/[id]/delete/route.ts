// src/app/api/conv/[id]/delete/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function sb() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

const TABLE = "conversations";

// ★ ポイント：第2引数は“インライン型”にする（または any にする）
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const client = sb();

    const { error } = await client
      .from(TABLE)
      .delete()
      .eq("conversation_code", params.id);

    if (error) throw error;

    return NextResponse.json({ ok: true, id: params.id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "DELETE failed" },
      { status: 500 }
    );
  }
}
