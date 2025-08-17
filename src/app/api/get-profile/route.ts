// src/app/api/get-profile/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabaseServer"; // ← あなたのサーバー用クライアントに合わせて

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const code = searchParams.get("code");

  if (!code) {
    return NextResponse.json({ error: "Missing user code" }, { status: 400 });
  }

  const { data, error } = await supabaseServer
    .from("profiles")
    .select("*")
    .eq("user_code", code)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json(data, { status: 200 });
}
