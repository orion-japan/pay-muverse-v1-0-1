// src/lib/iros/generate.ts
// Iros 1ターン返信生成コア

import OpenAI from 'openai';
import { getSystemPrompt, type IrosMeta, type IrosMode } from './system';

const IROS_MODEL =
  process.env.IROS_MODEL ??
  process.env.OPENAI_MODEL ??
  'gpt-4.1-mini';

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

export type GenerateArgs = {
  conversationId?: string;
  text: string;
  meta?: IrosMeta;
};

export type GenerateResult = {
  content: string;     // Iros 本文
  text: string;        // 旧 chatCore 互換用（= content と同じ）
  mode: IrosMode;      // 実際に使っているモード（meta.mode が無ければ mirror）
};

/**
 * Iros 応答を 1ターン生成する。
 * - system.ts の IROS_SYSTEM + meta を使って system プロンプトを組み立てる
 * - content / text / mode を返す（text / mode は旧 chatCore のための互換フィールド）
 */
export async function generateIrosReply(
  args: GenerateArgs,
): Promise<GenerateResult> {
  const { text, meta } = args;

  const system = getSystemPrompt(meta);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    { role: 'user', content: text },
  ];

  const res = await client.chat.completions.create({
    model: IROS_MODEL,
    messages,
    temperature: 0.7,
  });

  const content =
    res.choices[0]?.message?.content?.toString().trim() ?? '';

  const mode: IrosMode = meta?.mode ?? 'mirror';

  return {
    content,
    text: content,
    mode,
  };
}
