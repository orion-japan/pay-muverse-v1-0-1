// src/app/api/qcode/log/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { buildQCode } from "@/lib/qcodes"; // ← ブリッジ: src/lib/qcode.ts が qcodes.ts を再エクスポート

type IncomingBody = {
  user_code: string;

  // 任意メタ
  source_type?: string | null;   // 例: "sofia" | "mu" | "habit"
  source_id?: string | null;     // 例: 会話ID/投稿ID など
  intent?: string | null;        // 例: "diagnosis" | "habit_tick"
  emotion?: string | null;
  level?: string | null;

  // どちらかでOK（q+stage か q_code）
  q?: string | null;             // 例: "Q3"
  stage?: string | null;         // 例: "S2"
  q_code?: any;                  // 直接 JSON を渡す場合

  // 追加フィールド（テーブル仕様に応じて）
  post_id?: string | null;       // NOT NULL の場合は必須で渡す
  owner_user_code?: string | null;
  actor_user_code?: string | null;
  extra?: any;                   // 任意メタ
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as IncomingBody;

    const {
      user_code,
      source_type = "sofia",
      source_id = null,
      intent = null,
      emotion = null,
      level = null,
      q = null,
      stage = null,
      q_code = null,
      post_id = null,
      owner_user_code = null,
      actor_user_code = null,
      extra = null,
    } = body ?? ({} as IncomingBody);

    if (!user_code) {
      return NextResponse.json({ error: "user_code is required" }, { status: 400 });
    }

    // ===== q_code を正規化 =====
    // ① 既に q_code（JSON）が渡っていれば、表記ゆれを吸収して正規化
    // ② なければ q + stage から組み立て
    let normalized_q_code: {
      current_q: "Q1" | "Q2" | "Q3" | "Q4" | "Q5";
      depth_stage: string;
      intent?: string | null;
      ts_at?: string;
      meta?: any;
    } | null = null;

    if (q_code) {
      // camel/snake/別名の吸収
      const current_q =
        q_code.current_q ?? q_code.currentQ ?? q_code.q ?? null;
      const depth_stage =
        q_code.depth_stage ?? q_code.depthStage ?? q_code.stage ?? null;

      if (!current_q || !depth_stage) {
        return NextResponse.json(
          { error: "invalid q_code: current_q/depth_stage are required" },
          { status: 400 }
        );
      }

      normalized_q_code = {
        current_q,
        depth_stage,
        intent: q_code.intent ?? intent ?? null,
        ts_at: q_code.ts_at ?? new Date().toISOString(),
        meta: q_code.meta ?? extra ?? null,
      };
    } else {
      // q と stage から生成（hint/depth_stage で渡す）
      if (!q || !stage) {
        return NextResponse.json(
          { error: "q and stage are required (or pass q_code JSON)" },
          { status: 400 }
        );
      }
      const built = buildQCode({
        hint: q,
        depth_stage: stage,
        intent,
        ts_at: new Date().toISOString(),
      });

      normalized_q_code = {
        current_q: built.current_q,
        depth_stage: (built as any).depth_stage, // buildQCode 仕様に合わせる
        intent: built.intent ?? intent ?? null,
        ts_at: built.ts_at,
        meta: extra ?? null,
      };
    }

    // 念のため最終バリデーション
    if (!normalized_q_code?.current_q || !normalized_q_code?.depth_stage) {
      return NextResponse.json(
        { error: "q_code normalization failed" },
        { status: 400 }
      );
    }

    // ===== 挿入ペイロード作成 =====
    const insertPayload: Record<string, any> = {
      user_code,
      source_type,
      source_id,
      intent,
      emotion,
      level,
      q_code: normalized_q_code,
      owner_user_code,
      actor_user_code,
      extra,
    };

    // post_id が null で NOT NULL 制約があるテーブルなら、ここで弾く or ダミー値を入れる
    if (post_id !== null && post_id !== undefined) {
      insertPayload.post_id = post_id;
    }

    // ===== Supabase へ挿入 =====
    const { data, error } = await supabaseAdmin
      .from("q_code_logs") // ← テーブル名は運用に合わせて
      .insert([insertPayload])
      .select("id, created_at")
      .limit(1);

    if (error) {
      console.error("[q_code_logs.insert] error:", error);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, inserted: data?.[0] ?? null });
  } catch (e: any) {
    console.error("[q_code_logs] fatal:", e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? "unknown" },
      { status: 500 }
    );
  }
}
