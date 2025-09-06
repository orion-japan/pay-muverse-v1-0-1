// src/lib/mu/index.ts
// Mu 関連のエクスポート集約ポイント

export { buildMuSystemPrompt } from "./buildSystemPrompt";
export { MU_AGENT, MU_UI_TEXT, MU_CONFIG_VERSION } from "./config";

// 型は export type、値は通常の export に分離
export type { MuCredits } from "./credits";
export { getMuTextCredit, getMuImageCredit } from "./credits";

// ★ Mu 返信生成
export { generateMuReply } from "./generate";

// ★ Qコード／ターン記録関連
export * from "@/lib/qcode/muPolicy";
export * from "@/lib/qcode/recordMuTurn";
export * from "@/lib/qcode/bridgeImage";
export * from "@/lib/qcode/validators";

// =========================
// Qコード記録（Sofia流用）
// =========================
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Params = {
  user_code: string;           // 例: "669933"
  conversation_code?: string;  // 例: "Q1756..."（あれば）
  intent?: "diagnosis" | string;
  q: "Q1" | "Q2" | "Q3" | "Q4" | "Q5";
  stage: "S1" | "S2" | "S3";
  emotion?: string | null;
  level?: string | null;
  post_id?: string | null;     // テーブルで NOT NULL なら必須
  owner_user_code?: string | null;
  actor_user_code?: string | null;
  extra?: Record<string, any> | null;
};

export async function recordQFromSofia(p: Params) {
  const q_code = {
    ts: Math.floor(Date.now() / 1000),
    currentQ: p.q,
    depthStage: p.stage,
    meta: p.extra ?? undefined,
  };

  const { data, error } = await supabaseAdmin
    .from("q_code_logs")
    .insert([{
      user_code: p.user_code,
      source_type: "sofia",
      source_id: p.conversation_code ?? null,
      intent: p.intent ?? "diagnosis",
      emotion: p.emotion ?? null,
      level: p.level ?? null,
      q_code,
      post_id: p.post_id ?? null,
      owner_user_code: p.owner_user_code ?? null,
      actor_user_code: p.actor_user_code ?? null,
      extra: p.extra ?? null,
    }])
    .select("id, created_at")
    .single();

  if (error) throw error;
  return data;
}
