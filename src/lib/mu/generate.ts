// src/lib/mu/generate.ts
import { buildMuSystemPrompt } from './buildSystemPrompt';
import { MU_AGENT } from './config';

export type MuContext = {
  user_code: string;
  master_id: string;               // 親（= conversation_id / conversation_code）
  sub_id: string;                  // 子（分岐）
  thread_id?: string | null;
  board_id?: string | null;
  source_type?: string | null;     // 'chat' | 'board' | 'self' など
};

export type MuGenerateResult = {
  reply: string;
  q_code?: string | null;
  depth_stage?: string | null;
  confidence?: number | null;
};

export async function generateMuReply(
  message: string,
  ctx: MuContext
): Promise<MuGenerateResult> {
  // --- System Prompt（既存ビルドをそのまま利用。型は一旦 any で橋渡し）
  const system = buildMuSystemPrompt({
    user_code: ctx.user_code,
    master_id: ctx.master_id,
    sub_id: ctx.sub_id,
    source_type: ctx.source_type ?? 'chat',
    thread_id: ctx.thread_id ?? null,
    board_id: ctx.board_id ?? null,
  } as any);

  // --- モデル設定（あるものを優先）
  const model =
    (MU_AGENT as any)?.model ??
    process.env.MU_MODEL ??
    'gpt-4o-mini';

  const temperature =
    (MU_AGENT as any)?.temperature ??
    Number(process.env.MU_TEMPERATURE ?? 0.7);

  const key = process.env.OPENAI_API_KEY;

  // ★キー未設定でも落ちないよう簡易モック（本番はキー必須）
  if (!key) {
    return {
      reply: `（mock）${message}`,
      q_code: null,
      depth_stage: null,
      confidence: null,
    };
  }

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`OpenAI error: ${resp.status} ${detail}`);
  }

  const data = await resp.json();
  const text: string = data?.choices?.[0]?.message?.content ?? '';

  // 戻り値のキーは「reply」で統一（route.ts と整合）
  return {
    reply: String(text),
    q_code: null,
    depth_stage: null,
    confidence: null,
  };
}
