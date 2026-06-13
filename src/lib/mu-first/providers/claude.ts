import { MU_FIRST_SCREENSHOT_PROMPT } from '../prompt';
import type { AnalyzeScreenshotParams, AnalyzeScreenshotResult, VisionModelKey } from '../types';

function requireAnthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  return key;
}

function toAnthropicModel(model: VisionModelKey) {
  if (model === 'claude-sonnet') return process.env.CLAUDE_SONNET_MODEL || 'claude-3-5-sonnet-20241022';
  return process.env.CLAUDE_HAIKU_MODEL || 'claude-3-5-haiku-20241022';
}

export async function analyzeWithClaude(
  params: AnalyzeScreenshotParams,
): Promise<AnalyzeScreenshotResult> {
  const key = requireAnthropicKey();

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: toAnthropicModel(params.model),
      max_tokens: 320,
      temperature: 0.35,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: MU_FIRST_SCREENSHOT_PROMPT },
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: params.mimeType,
                data: params.imageBase64,
              },
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude analyze failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const text = String(
    json?.content?.find((part: any) => part?.type === 'text')?.text ?? '',
  ).trim();

  if (!text) throw new Error('Claude returned empty text');

  return { text, model: params.model };
}
