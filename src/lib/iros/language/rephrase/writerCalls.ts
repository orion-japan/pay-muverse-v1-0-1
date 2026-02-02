// =============================================
// file: src/lib/iros/language/rephrase/writerCalls.ts
// ✅ buildFirstPassMessages を「最後 user で終わる」ように拡張
// =============================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { chatComplete } from '../../../llm/chatComplete';

export type WriterMessage = { role: 'system' | 'user' | 'assistant'; content: string };

type TurnMsg = { role: 'user' | 'assistant'; content: string };

function norm(s: unknown) {
  return String(s ?? '').replace(/\r\n/g, '\n').trim();
}

function turnsToMessages(turns?: TurnMsg[] | null): WriterMessage[] {
  if (!Array.isArray(turns) || turns.length === 0) return [];
  return turns
    .map((t) => {
      const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
      const content = norm((t as any)?.content);
      if (!role || !content) return null;
      return { role, content } as WriterMessage;
    })
    .filter(Boolean) as WriterMessage[];
}

/**
 * ✅ 1st pass: system + (internalPack as user) + turns + (finalUserText as user)
 * - internalPack は常に user（system にしない）
 * - internalPack を最後に置かない（user,user 連投や会話崩れを防ぐ）
 * - ✅ 最後は必ず user で終わらせる（ChatCompletions の基本形を保証）
 */
export function buildFirstPassMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;

  // ✅ 追加：最後に user として置く本文（通常は userText or seedDraft）
  finalUserText?: string | null;
}): WriterMessage[] {
  const systemPrompt = String(args.systemPrompt ?? '');
  const internalPack = norm(args.internalPack ?? '');
  const turns = turnsToMessages(args.turns);
  const finalUserText = norm(args.finalUserText ?? '');

  const out: WriterMessage[] = [{ role: 'system', content: systemPrompt }];

  // internalPack は system の直後に置く（最後にしない）
  if (internalPack) out.push({ role: 'user', content: internalPack });

  // 直近ターン（会話の流れ）
  out.push(...turns);

  // ✅ 最後を user で終わらせる
  if (finalUserText) {
    const last = out[out.length - 1];
    const sameAsLastUser = last?.role === 'user' && norm(last?.content) === finalUserText;
    if (!sameAsLastUser) out.push({ role: 'user', content: finalUserText });
  }

  return out;
}

/**
 * ✅ retry/repair: system + turns + (internalPack as user) + repair-instruction + userText
 * - internalPack を system にしない（system 増殖を止める）
 * - “編集タスク” は user で渡す
 */
export function buildRetryMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;
  baseDraftForRepair: string;
  userText: string;
}): WriterMessage[] {
  const systemPrompt = String(args.systemPrompt ?? '');
  const internalPack = String(args.internalPack ?? '');
  const baseDraft = norm(args.baseDraftForRepair) || '(empty)';
  const userText = norm(args.userText) || '（空）';

  return [
    { role: 'system', content: systemPrompt },
    ...turnsToMessages(args.turns),
    { role: 'user', content: internalPack },
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


// =============================================
// file: src/lib/iros/language/rephrase/rephraseEngine.full.ts
// ✅ buildFirstPassMessages 呼び出しに finalUserText を渡す
// （該当1行だけ置き換え）
// =============================================
//
// 変更前：
// const messages = buildFirstPassMessages({ systemPrompt, internalPack, turns: lastTurnsSafe });
//
// 変更後：
/*
const messages = buildFirstPassMessages({
  systemPrompt,
  internalPack,
  turns: lastTurnsSafe,
  finalUserText: seedDraft || userText,
});
*/
