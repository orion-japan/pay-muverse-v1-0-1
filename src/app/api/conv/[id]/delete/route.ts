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

// ★ ここがポイント：第2引数は any（または型注釈を外す）
export async function DELETE(_req: NextRequest, context: any) {
  try {
    const id = context?.params?.id as string | undefined;
    if (!id) {
      return NextResponse.json({ error: "missing id" }, { status: 400 });
    }

    const client = sb();
    const { error } = await client.from(TABLE).delete().eq("conversation_code", id);
    if (error) throw error;

    return NextResponse.json({ ok: true, id });
  } catch (error: any) {
    return NextResponse.json(
      { error: error?.message ?? "DELETE failed" },
      { status: 500 }
    );
  }
}

