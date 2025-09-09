// src/lib/mirra/generate.ts
import OpenAI from 'openai';
import { MIRRA_CONFIG } from './config';
import { buildMirraSystemPrompt } from './buildSystemPrompt';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || '' });

export async function generateMirraReply(userText: string) {
  const system = buildMirraSystemPrompt();
  const resp = await client.chat.completions.create({
    model: 'gpt-4.1-mini',
    temperature: 0.5,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userText || '（無言）' },
    ],
  });

  const content = resp.choices?.[0]?.message?.content?.trim() || '';
  return {
    text: content,
    cost: MIRRA_CONFIG.COST_PER_TURN,
    meta: { model: 'gpt-4.1-mini', agent: MIRRA_CONFIG.agent },
  };
}
