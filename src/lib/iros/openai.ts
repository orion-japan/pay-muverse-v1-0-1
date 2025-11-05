// src/lib/iros/openai.ts
// route.ts の利用に合わせて、chatComplete は string を返す。
// （呼び出し側は `let content = await chatComplete({ ... })` でそのまま代入）

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

type ChatArgs = {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
};

export async function chatComplete({
  apiKey,
  model,
  messages,
  temperature = 0.7,
  max_tokens = 420,
  endpoint = 'https://api.openai.com/v1/chat/completions',
}: ChatArgs): Promise<string> {
  if (!apiKey) throw new Error('OPENAI_API_KEY is missing');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, temperature, max_tokens, messages }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`openai_error: ${detail || res.statusText}`);
  }

  const json = await res.json();
  const content: string =
    json?.choices?.[0]?.message?.content?.toString?.().trim?.() || '';

  return content;
}
