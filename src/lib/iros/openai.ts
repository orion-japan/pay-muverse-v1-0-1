// /src/lib/iros/openai.ts
// Iros 向け LLM 呼び出しの薄いラッパ
// - 必ず string を返す
// - route.ts 側が期待する `runIrosChat` を公開

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

type ChatArgs = {
  apiKey?: string;                 // 省略時は process.env.OPENAI_API_KEY
  model: string;                   // 例: 'gpt-4o-mini'
  system?: string;                 // 先頭に挿入する system
  history?: ChatMessage[];         // 既存履歴（system を含めないことを推奨）
  user_text: string;               // 今回のユーザー発話
  temperature?: number;            // 例: 0.4
  max_tokens?: number;             // 例: 420
  endpoint?: string;               // 既定: chat.completions
  extraHeaders?: Record<string, string>;
};

// 低レベル: chat.completions 生ラッパ（常に string を返す）
export async function chatComplete({
  apiKey = process.env.OPENAI_API_KEY || '',
  model,
  messages,
  temperature = 0.6,
  max_tokens = 512,
  endpoint = 'https://api.openai.com/v1/chat/completions',
  extraHeaders = {},
}: {
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
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

// 高レベル: route.ts から呼ぶ想定のユーティリティ（必ず string を返す）
export async function runIrosChat({
  apiKey,
  model,
  system,
  history = [],
  user_text,
  temperature = 0.4,
  max_tokens = 420,
  endpoint,
  extraHeaders,
}: ChatArgs): Promise<string> {
  const msgs: ChatMessage[] = [];

  if (system && system.trim()) {
    msgs.push({ role: 'system', content: system.trim() });
  }
  if (Array.isArray(history) && history.length > 0) {
    // role と content の最低限チェック
    for (const m of history) {
      if (!m || typeof m.content !== 'string') continue;
      const role = (m.role as ChatRole) || 'user';
      msgs.push({ role, content: m.content });
    }
  }

  msgs.push({ role: 'user', content: String(user_text ?? '') });

  // string を必ず返す
  return chatComplete({
    apiKey,
    model,
    messages: msgs,
    temperature,
    max_tokens,
    endpoint,
    extraHeaders,
  });
}

// 互換性: 既存コードで default/named どちらでも使えるように
export default { runIrosChat, chatComplete };
