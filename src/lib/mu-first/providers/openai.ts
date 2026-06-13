import OpenAI from 'openai';

import { MU_FIRST_SCREENSHOT_PROMPT } from '../prompt';
import type { AnalyzeScreenshotParams, AnalyzeScreenshotResult } from '../types';

function getClient() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export async function analyzeWithOpenAI(
  params: AnalyzeScreenshotParams,
): Promise<AnalyzeScreenshotResult> {
  const client = getClient();

  const res = await client.chat.completions.create({
    model: process.env.OPENAI_MU_FIRST_MODEL || 'gpt-4.1-mini',
    temperature: 0.35,
    max_tokens: 320,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: MU_FIRST_SCREENSHOT_PROMPT },
          {
            type: 'image_url',
            image_url: {
              url: `data:${params.mimeType};base64,${params.imageBase64}`,
            },
          },
        ],
      },
    ],
  });

  const text = String(res.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('OpenAI returned empty text');

  return { text, model: params.model };
}
