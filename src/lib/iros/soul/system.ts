// src/lib/iros/soul/system.ts
// Iros Soul Engine 用メッセージ組み立て
// - prompt.ts の buildSoulPrompt を使って
//   OpenAI ChatCompletion 用の messages 配列を作る

import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type { IrosSoulInput } from './types';
import { buildSoulPrompt } from './prompt';

/**
 * 互換用のダミー定数（古いコードから参照されても落ちないようにだけ残す）
 * 実際のプロンプト内容は buildSoulPrompt 側で組み立てます。
 */
export const IROS_SOUL_SYSTEM_PROMPT = '[IrosSoul] use buildSoulPrompt() instead.';

/**
 * IrosSoulInput から、Soul LLM に渡す messages を組み立てる。
 * ここでは構造だけを固定し、文言の中身は prompt.ts に委ねる。
 */
export function buildIrosSoulMessages(
  input: IrosSoulInput,
): ChatCompletionMessageParam[] {
  const { system, user } = buildSoulPrompt(input);

  const messages: ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: system,
    },
    {
      role: 'user',
      content: user,
    },
  ];

  return messages;
}
