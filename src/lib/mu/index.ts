// src/lib/mu/index.ts
// Mu 関連のエクスポート集約ポイント（構造維持・拡張）

// --- Prompt builder（v2：persona/mode/tone 合成） ---
export { buildMuSystemPrompt, MU_PROMPT_VERSION } from './buildSystemPrompt';
export type { MuMode, MuTone, BuildMuPromptOptions } from './buildSystemPrompt';

// --- Config（UI/emoji/credits 等） ---
export { MU_AGENT, MU_UI_TEXT, MU_CONFIG_VERSION } from './config';
export { MU_CONFIG } from './config';

// --- Credits ---
export type { MuCredits } from './credits';
export { getMuTextCredit, getMuImageCredit } from './credits';

// --- Mu 返信生成（LLM 呼び出しの入口） ---
export { generateMuReply } from './generate';

// --- Qコード／ターン記録関連（衝突回避：名前空間で再エクスポート） ---
export * as MuPolicy     from '@/lib/qcode/muPolicy';
export * as MuRecord     from '@/lib/qcode/recordMuTurn';
export * as MuImage      from '@/lib/qcode/bridgeImage';
export * as QValidators  from '@/lib/qcode/validators';

// --- 互換レイヤ（既存コードがトップレベル import を想定している箇所向け） ---
// recordMuTurn は存在しない実装のため、recordMuTextTurn を別名で公開して互換維持
export {
  recordMuTextTurn,
  recordMuTextTurn as recordMuTurn,
} from '@/lib/qcode/recordMuTurn';
export type { IntentTag } from '@/lib/qcode/recordMuTurn';

// =========================
// Qコード記録（Sofia流用）
// =========================
import { supabaseAdmin } from '@/lib/supabaseAdmin';

type Params = {
  user_code: string;           // 例: "669933"
  conversation_code?: string;  // 例: "Q1756..."（あれば）
  intent?: 'diagnosis' | string;
  q: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
  stage: 'S1' | 'S2' | 'S3';
  emotion?: string | null;
  level?: string | null;
  post_id?: string | null;     // テーブルが NOT NULL の場合は必須に合わせる
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
    .from('q_code_logs')
    .insert([
      {
        user_code: p.user_code,
        source_type: 'sofia',
        source_id: p.conversation_code ?? null,
        intent: p.intent ?? 'diagnosis',
        emotion: p.emotion ?? null,
        level: p.level ?? null,
        q_code,
        post_id: p.post_id ?? null,
        owner_user_code: p.owner_user_code ?? null,
        actor_user_code: p.actor_user_code ?? null,
        // ↓ q_code_logs に extra カラムが無い場合はこの1行を削除してください
        extra: p.extra ?? null,
      },
    ])
    .select('id, created_at')
    .single();

  if (error) throw error;
  return data;
}
