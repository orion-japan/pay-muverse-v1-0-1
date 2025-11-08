// src/lib/llm/chatComplete.ts
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type ChatArgs = {
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  endpoint?: string; // 既定: chat.completions
  extraHeaders?: Record<string, string>;
};

export async function chatComplete({
  apiKey = process.env.OPENAI_API_KEY || '',
  model,
  messages,
  temperature = 0.6,
  max_tokens = 512,
  endpoint = 'https://api.openai.com/v1/chat/completions',
  extraHeaders = {},
}: ChatArgs): Promise<string> {
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content;

  if (typeof raw !== 'string') {
    throw new Error(`LLM returned non-string content: ${typeof raw}`);
  }

  const out = raw.toString().trim();
  if (!out) throw new Error('LLM empty content');
  return out;
}
