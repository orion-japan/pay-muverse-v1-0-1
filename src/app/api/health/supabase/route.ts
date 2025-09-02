import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Edge ではなく Node.js で実行（service role key を安全に使うため）
export const runtime = "nodejs";

export async function GET() {
  try {
    const tried: string[] = [];
    const ok: { table: string; count: number | null }[] = [];

    // 存在する可能性が高い順に試す（どれか一つでも成功すれば接続OKとみなす）
    const tables = ["q_code_logs", "user_q_codes", "sofia_conversations", "posts", "users"];

    for (const table of tables) {
      tried.push(table);
      const { error, count } = await supabaseAdmin
        .from(table)
        .select("*", { count: "exact", head: true }); // レコード数だけ取得（実体は返さない）

      if (!error) ok.push({ table, count: count ?? null });
    }

    const connected = ok.length > 0;

    return NextResponse.json({
      connected,
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      tried,
      ok,
    });
  } catch (e: any) {
    return NextResponse.json(
      { connected: false, error: e?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
