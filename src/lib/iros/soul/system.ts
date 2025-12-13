// src/lib/iros/soul/system.ts
// Soul LLM に渡す messages を組み立てる（prompt.ts を唯一の正とする）

import type { ChatCompletionMessageParam } from 'openai/resources/chat';
import type { IrosSoulInput } from './types';
import { buildSoulPrompt } from './prompt';

export function buildIrosSoulMessages(
  input: IrosSoulInput,
): ChatCompletionMessageParam[] {
  const { system, user } = buildSoulPrompt(input);

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}
