// =============================================
// file: src/lib/iros/language/rephrase/writerCalls.ts
// ✅ buildFirstPassMessages を「最後 user で終わる」ように拡張
// ✅ HistoryDigest v1 をここで注入できるようにする（唯一の choke point）
//
// 🚫 重要: userText（ユーザー発話の生文）は LLM に絶対に渡さない
// - finalUserText / userText など “生文が混入し得る入口” は、この層で強制遮断する
// =============================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { chatComplete } from '../../../llm/chatComplete';
import type { HistoryDigestV1 } from '../../history/historyDigestV1';
import { injectHistoryDigestV1 } from '../../history/historyDigestV1';

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
      if (!role) return null;

      // ✅ choke point：user の生文は絶対に LLM に渡さない（常にマスク）
      if (role === 'user') {
        return { role: 'user', content: '[USER]' } as WriterMessage;
      }

      // assistant は内容を許可（空は捨てる）
      const content = norm((t as any)?.content);
      if (!content) return null;
      return { role: 'assistant', content } as WriterMessage;
    })
    .filter(Boolean) as WriterMessage[];
}

function mergeConsecutiveSameRole(messages: WriterMessage[]): WriterMessage[] {
  const out: WriterMessage[] = [];
  for (const m of messages) {
    const lastMsg = out[out.length - 1];
    if (lastMsg && lastMsg.role === m.role) {
      lastMsg.content = `${norm(lastMsg.content)}\n\n${norm(m.content)}`.trim();
    } else {
      out.push({ role: m.role, content: norm(m.content) });
    }
  }
  return out.filter((m) => m.content.length > 0 || m.role !== 'assistant'); // assistant 空は弾く（念のため）
}

function ensureEndsWithUser(messages: WriterMessage[]): WriterMessage[] {
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'user') {
    return [...messages, { role: 'user', content: '（入力なし）' }];
  }
  return messages;
}

function foldLeadingSystemToOne(messages: WriterMessage[]): WriterMessage[] {
  if (messages.length <= 1) return messages;
  if (messages[0]?.role !== 'system') return messages;

  const head = { ...messages[0], content: norm(messages[0].content) } as WriterMessage;
  let i = 1;

  while (i < messages.length && messages[i]?.role === 'system') {
    const add = norm((messages[i] as any)?.content);
    if (add) head.content = `${head.content}\n\n${add}`.trim();
    i++;
  }

  if (i > 1) return [head, ...messages.slice(i)];
  return [head, ...messages.slice(1)];
}

/**
 * ✅ 1st pass: system + turns
 *
 * 🚫 userText 禁止:
 * - finalUserText は “userText or seedDraft” の混入経路になり得るため、ここでは一切採用しない
 * - 「最後は user で終わる」要件は turns の整形 + 末尾プレースホルダで満たす
 */
export function buildFirstPassMessages(args: any): WriterMessage[] {
  const systemPrompt = norm(args.systemPrompt ?? '');

  // ✅ 会話の線（topicDigest / conversationLine）を拾う（短く system 側に固定）
  const topicDigest = norm(args.topicDigest ?? '');
  const conversationLine = norm(args.conversationLine ?? '');
  const internalPackRaw = norm(args.internalPack ?? '');

  const conversationLineBlock = [topicDigest, conversationLine]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n');

  const systemOne = [
    systemPrompt,
    conversationLineBlock ? `CONVERSATION_LINE (DO NOT OUTPUT):\n${conversationLineBlock}` : '',
    internalPackRaw,
  ]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n\n');

  // ✅ turns は user をマスクしたうえで追加
  const turns = turnsToMessages(args.turns);

  let messages: WriterMessage[] = [{ role: 'system', content: systemOne }, ...turns];

  // ✅ role 連続をマージ
  messages = mergeConsecutiveSameRole(messages);

  // ✅ 末尾 user を保証（seedDraft は一切使わない）
  messages = ensureEndsWithUser(messages);

  // ✅ HistoryDigest v1 をここで注入（ある時だけ）
  const digest = (args.historyDigestV1 ?? null) as HistoryDigestV1 | null;
  if (digest) {
    const injected = injectHistoryDigestV1({ messages, digest }) as any;
    const injectedMsgs = (injected?.messages ?? null) as WriterMessage[] | null;
    if (Array.isArray(injectedMsgs) && injectedMsgs.length > 0) {
      messages = injectedMsgs;
    }
  }

  // ✅ 先頭の system は 1枚に畳む
  messages = foldLeadingSystemToOne(messages);

  // ✅ 最終的に末尾 user を再保証（注入で崩れた場合の保険）
  messages = ensureEndsWithUser(messages);

  return messages;
}

/**
 * ✅ retry/repair: system + turns + (single user message)
 *
 * 🚫 userText 禁止:
 * - userText は「具体語の強制」になり、テンプレ固定やリークの原因になるためここでは絶対に渡さない
 * - internalPack / 編集対象（baseDraft）のみで repair を行う
 */
export function buildRetryMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;
  baseDraftForRepair: string;

  // 互換のため残すが、この層では絶対に採用しない（LLMへ流さない）
  userText: string;
}): WriterMessage[] {
  const systemPrompt = norm(args.systemPrompt ?? '');
  const internalPack = norm(args.internalPack ?? '');
  const baseDraft = norm(args.baseDraftForRepair) || '(empty)';

  const mergedUser = [
    internalPack ? `【internal】\n${internalPack}` : '',
    [
      '【編集対象（この本文をベースに、壊さずに整える。露出禁止）】',
      '---BEGIN_DRAFT---',
      baseDraft,
      '---END_DRAFT---',
      '',
      '【出力ルール】',
      '- 出力は「整えた完成文のみ」。BEGIN/END や見出し、内部情報は出さない。',
      '- 下書きの構造を保持する（削り過ぎない）。',
      '',
      // 🚫 ユーザー入力（文脈）は入れない
    ].join('\n'),
  ]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n\n');

  let base: WriterMessage[] = [{ role: 'system', content: systemPrompt }, ...turnsToMessages(args.turns)];
  base = mergeConsecutiveSameRole(base);

  const lastMsg = base[base.length - 1];
  if (lastMsg && lastMsg.role === 'user') {
    lastMsg.content = `${norm(lastMsg.content)}\n\n${mergedUser}`.trim();
    base = foldLeadingSystemToOne(base);
    return ensureEndsWithUser(base);
  }

  base = [...base, { role: 'user', content: mergedUser }];
  base = foldLeadingSystemToOne(base);
  return ensureEndsWithUser(base);
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

  // ✅ 追加：HistoryDigest v1（存在する時だけ注入）
  historyDigestV1?: HistoryDigestV1 | null;
}): Promise<string> {
  // ✅ HistoryDigest v1 を注入（ある時だけ）
  const digest = (args.historyDigestV1 ?? null) as HistoryDigestV1 | null;
  const injected = digest ? (injectHistoryDigestV1({ messages: args.messages, digest }) as any) : null;

  let messagesFinal: WriterMessage[] = (injected?.messages ?? args.messages) as WriterMessage[];

  // ✅ 先頭 system は 1枚に畳む
  messagesFinal = foldLeadingSystemToOne(messagesFinal);

  // ✅ 末尾 user を保証（念のため）
  messagesFinal = ensureEndsWithUser(messagesFinal);

  const out = await chatComplete({
    purpose: 'writer',
    model: args.model,
    temperature: args.temperature,
    max_tokens: 700,
    messages: messagesFinal,
    extraBody: args.extraBody ?? {},
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode ?? null,

    // ✅ audit は top-level に置く（ChatArgs 準拠）
    audit: args.audit ?? null,

    trace: {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },
  });

  return norm(out ?? '');
}
