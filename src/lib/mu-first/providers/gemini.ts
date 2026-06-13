import { MU_FIRST_SCREENSHOT_PROMPT } from '../prompt';
import type { AnalyzeScreenshotParams, AnalyzeScreenshotResult } from '../types';

function requireGeminiKey() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  return key;
}

export async function analyzeWithGemini(
  params: AnalyzeScreenshotParams,
): Promise<AnalyzeScreenshotResult> {
  const key = requireGeminiKey();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${params.model}:generateContent?key=${encodeURIComponent(key)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: MU_FIRST_SCREENSHOT_PROMPT },
            {
              inline_data: {
                mime_type: params.mimeType,
                data: params.imageBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 320,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Gemini analyze failed: ${res.status} ${await res.text()}`);
  }

  const json = await res.json();
  const text = String(json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();

  if (!text) throw new Error('Gemini returned empty text');

  return { text, model: params.model };
}
