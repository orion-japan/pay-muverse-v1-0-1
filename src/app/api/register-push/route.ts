import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Supabase クライアント (Service Role Key を使う)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { user_code, endpoint, keys } = body;

    if (!user_code || !endpoint || !keys) {
      return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
    }

    // push_subscriptions テーブルに保存
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_code,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      { onConflict: "endpoint" }
    );

    if (error) {
      console.error("❌ Supabase insert error:", error.message);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("❌ API error:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
