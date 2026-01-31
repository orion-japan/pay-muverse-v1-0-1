/* eslint-disable @typescript-eslint/no-explicit-any */

import { chatComplete } from '../../../llm/chatComplete';

export type WriterMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function buildFirstPassMessages(args: {
  systemPrompt: string;
  internalPack: string;
}): WriterMessage[] {
  return [
    { role: 'system', content: String(args.systemPrompt ?? '') },
    // ✅ internalPack は「ユーザー入力」として渡す（lastUserHead が null にならない）
    { role: 'user', content: String(args.internalPack ?? '') },
  ];
}



export function buildRetryMessages(args: {
  systemPrompt: string;
  internalPack: string;
  baseDraftForRepair: string;
  userText: string;
}): WriterMessage[] {
  const baseDraft = String(args.baseDraftForRepair ?? '').trim() || '(empty)';
  const userText = String(args.userText ?? '').trim() || '（空）';

  return [
    { role: 'system', content: String(args.systemPrompt ?? '') },
    { role: 'system', content: String(args.internalPack ?? '') },
    {
      role: 'user',
      content: [
        '【編集対象（この本文をベースに、壊さずに整える。露出禁止）】',
        '---BEGIN_DRAFT---',
        baseDraft,
        '---END_DRAFT---',
        '',
        '【出力ルール】',
        '- 出力は「整えた完成文のみ」。BEGIN/END や見出し、内部情報は出さない。',
        '- 下書きの構造を保持する（削り過ぎない）。',
      ].join('\n'),
    },
    { role: 'user', content: userText },
  ];
}

export async function callWriterLLM(args: {
  model: string;
  temperature: number;
  messages: WriterMessage[];
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
  extraBody?: any;
  audit?: any;
}): Promise<string> {
  const out = await chatComplete({
    purpose: 'reply',
    model: args.model,
    temperature: args.temperature,
    max_tokens: 700,
    messages: args.messages,
    extraBody: args.extraBody ?? {},
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode ?? null,
    trace: {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },
    audit: args.audit ?? {},
  } as any);

  return String(out ?? '');
}
