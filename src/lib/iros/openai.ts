// /src/lib/iros/openai.ts
// Iros 向け LLM 呼び出しの互換ラッパ（※出口ではない）
//
// 方針：OpenAI へ出ていく「出口」は src/lib/llm/chatComplete.ts のみ。
// ここは route.ts 等の既存呼び出し互換のために残すが、HTTP送信はしない。

import {
  chatComplete as chatCompleteExit,
  type ChatMessage as ExitChatMessage,
} from '@/lib/llm/chatComplete';

export type ChatRole = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };

type ChatArgs = {
  apiKey?: string; // 省略時は process.env.OPENAI_API_KEY
  model: string; // 例: 'gpt-4o-mini'
  system?: string; // 先頭に挿入する system
  history?: ChatMessage[]; // 既存履歴（system を含めないことを推奨）
  user_text: string; // 今回のユーザー発話
  temperature?: number; // 例: 0.4
  max_tokens?: number; // 例: 420
  endpoint?: string; // 既定: chat.completions
  extraHeaders?: Record<string, string>;
};

// 互換: 以前の chatComplete を参照している箇所があっても壊さない。
// ただし “出口” は llm/chatComplete のみ。
export async function chatComplete(args: {
  apiKey?: string;
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  endpoint?: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const { apiKey, model, messages, temperature, max_tokens, endpoint, extraHeaders } =
    args;

  // 型を出口側に合わせる（role/content は同じ）
  const msgs: ExitChatMessage[] = (messages ?? []).map((m) => ({
    role: m.role,
    content: String(m.content ?? ''),
  }));

  return chatCompleteExit({
    purpose: 'writer', // ※互換呼び出しの既定。用途が分かる箇所は呼び元で purpose を使う方針へ移行。
    apiKey,
    model,
    messages: msgs,
    temperature,
    max_tokens,
    endpoint,
    extraHeaders,
  });
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
    for (const m of history) {
      if (!m || typeof m.content !== 'string') continue;
      const role: ChatRole =
        m.role === 'system' || m.role === 'user' || m.role === 'assistant'
          ? m.role
          : 'user';
      msgs.push({ role, content: m.content });
    }
  }

  msgs.push({ role: 'user', content: String(user_text ?? '') });

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
