// src/app/api/conv/[id]/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ★ サーバー側キーでOK（環境に応じて置き換え）
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function sb() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
}

// 会話テーブル名（あなたの環境に合わせて変更）
// 例: "conversations" / "sofia_conversations" / "chat_conversations" など
const TABLE = "conversations"; // ←必要ならリネーム

// id は「conversation_code」を想定（一覧APIのスクショに合わせて）
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const { title } = (await req.json()) as { title?: string };
    if (!title || !title.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const client = sb();
    const { data, error } = await client
      .from(TABLE)
      .update({ title, updated_at: new Date().toISOString() })
      .eq("conversation_code", params.id)
      .select("conversation_code, title")
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ error: "not found" }, { status: 404 });

    return NextResponse.json({ id: data.conversation_code, title: data.title });
  } catch (error: any) {
    return NextResponse.json({ error: error.message ?? "PATCH failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const client = sb();

    const { error } = await client
      .from(TABLE)
      .delete()
      .eq("conversation_code", params.id);

    if (error) throw error;

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message ?? "DELETE failed" }, { status: 500 });
  }
}
