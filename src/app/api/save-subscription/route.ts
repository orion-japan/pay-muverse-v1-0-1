import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // 👈 ここは Service Role Key 必須
);

export async function POST(req: NextRequest) {
  try {
    const { user_code, subscription } = await req.json();

    if (!user_code || !subscription) {
      return NextResponse.json({ ok: false, error: "invalid params" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('subscriptions')
      .upsert(
        { user_code, subscription },
        { onConflict: 'user_code' } // 👈 同じユーザーは上書き保存
      )
      .select();

    if (error) throw error;

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
