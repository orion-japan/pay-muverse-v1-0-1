import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { adminAuth } from "@/lib/firebase-admin";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!,
  { auth: { persistSession: false } }
);

export async function POST(req: NextRequest) {
  try {
    const { visibility } = await req.json();
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: "認証トークンがありません" }, { status: 401 });
    }
    const decoded = await adminAuth.verifyIdToken(token, true);
    const firebase_uid = decoded.uid;

    // user_code を取得
    const { data, error } = await supabase
      .from("users")
      .select("user_code")
      .eq("firebase_uid", firebase_uid)
      .single();

    if (error || !data) {
      return NextResponse.json({ error: "ユーザーが見つかりません" }, { status: 404 });
    }

    await supabase
      .from("users")
      .update({ ship_visibility: visibility })
      .eq("user_code", data.user_code);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500 });
  }
}
