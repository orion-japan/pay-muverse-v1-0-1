import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildQCode } from "@/lib/qcode";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      user_code,                 // 例: "669933"（必須）
      source_type = "sofia",     // 例: "sofia"（AI）
      source_id = null,          // 例: 会話コードなど
      intent = null,             // 例: "diagnosis"
      emotion = null,
      level = null,
      // 下のどちらかでOK：
      q,                         // 例: "Q3"
      stage,                     // 例: "S2"
      q_code,                    // 直接 JSON を渡す場合はこちら
      // 任意フィールド
      post_id = null,            // テーブルが NOT NULL の場合は必ず渡す
      owner_user_code = null,
      actor_user_code = null,
      extra = null,
    } = body ?? {};

    if (!user_code) {
      return NextResponse.json({ error: "user_code is required" }, { status: 400 });
    }

    // q_code を持ってなければ組み立てる
    const qcode = q_code ?? buildQCode({ q, stage, meta: extra });

    if (!qcode?.currentQ || !qcode?.depthStage) {
      return NextResponse.json(
        { error: "q and stage are required (or pass q_code JSON)" },
        { status: 400 }
      );
    }

    const insertPayload: any = {
      user_code,
      source_type,
      source_id,
      intent,
      emotion,
      level,
      q_code: qcode,
      post_id,             // NOT NULL制約がある場合はnullを避けてください
      owner_user_code,
      actor_user_code,
      extra,
    };

    const { data, error } = await supabaseAdmin
      .from("q_code_logs")
      .insert([insertPayload])
      .select("id, created_at");

    if (error) throw error;

    return NextResponse.json({ ok: true, inserted: data?.[0] ?? null });
  } catch (e: any) {
    console.error(e);
    return NextResponse.json({ ok: false, error: e?.message ?? "unknown" }, { status: 500 });
  }
}
