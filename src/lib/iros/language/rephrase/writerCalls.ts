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
      const content = norm((t as any)?.content);
      if (!role || !content) return null;
      return { role, content } as WriterMessage;
    })
    .filter(Boolean) as WriterMessage[];
}

/**
 * ✅ 1st pass: system + (internalPack as user) + turns
 *
 * 🚫 userText 禁止:
 * - finalUserText は “userText or seedDraft” の混入経路になり得るため、ここでは一切採用しない
 * - 「最後は user で終わる」要件は、internalPack / turns の整形で満たす（必要なら turns 側に入る）
 */
export function buildFirstPassMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;

  // ✅ “最後の user” を保証するための安全seed（userText生文ではない）
  seedDraft?: string | null;

  // 互換のため残すが、この層では絶対に採用しない（LLMへ流さない）
  finalUserText?: string | null;
}): WriterMessage[] {
  const systemPrompt = String(args.systemPrompt ?? '').trim();
  const internalPack = norm(args.internalPack ?? '');
  const seedDraft = norm(args.seedDraft ?? '');

  const turns = turnsToMessages(args.turns);

  // ✅ internalPack は “system に畳む” （user にしない）
  const systemOne = [systemPrompt, internalPack].filter((x) => x.trim().length > 0).join('\n\n');

  const out: WriterMessage[] = [{ role: 'system', content: systemOne }];

  // ✅ 直近ターン（会話の流れ）を追加（role連続はマージ）
  for (const m of turns) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`.trim();
    } else {
      out.push(m);
    }
  }

  // ✅ 最後を user で終わらせたいなら “seedDraft” を末尾に置く
  // - userText 生文は入れない（禁止ルール保持）
  if (seedDraft) {
    const last = out[out.length - 1];
    if (last && last.role === 'user') {
      last.content = `${last.content}\n\n${seedDraft}`.trim();
    } else {
      out.push({ role: 'user', content: seedDraft });
    }
  }

  return out;
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
  const systemPrompt = String(args.systemPrompt ?? '');
  const internalPack = norm(args.internalPack ?? '');
  const baseDraft = norm(args.baseDraftForRepair) || '(empty)';

  // 🚫 強制遮断
  // const userText = norm(args.userText) || '（空）';

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
      // '【ユーザー入力（文脈）】',
      // userText,
    ].join('\n'),
  ]
    .filter((x) => String(x).trim().length > 0)
    .join('\n\n');

  const base: WriterMessage[] = [
    { role: 'system', content: systemPrompt },
    ...turnsToMessages(args.turns),
  ];

  // ✅ 末尾が user なら「追い user」を作らず、最後の user に結合する
  const last = base[base.length - 1];
  if (last && last.role === 'user') {
    last.content = `${String(last.content ?? '').trim()}\n\n${mergedUser}`.trim();
    return base;
  }

  return [...base, { role: 'user', content: mergedUser }];
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
  // ✅ HistoryDigest v1 を注入（ただし system は “1枚に畳む”）
  // - rephraseEngine 側で allow/exprMeta/blockPlan が system 追加されても、ここで最終的に 1枚化する
  const digest = (args.historyDigestV1 ?? null) as HistoryDigestV1 | null;
  const injected = digest ? injectHistoryDigestV1({ messages: args.messages, digest }) : null;

  let messagesFinal: WriterMessage[] = (injected?.messages ?? args.messages) as WriterMessage[];

  // ✅ 先頭に連続する system を 1枚に畳む（system,system,... を禁止）
  if (messagesFinal.length > 1 && messagesFinal[0]?.role === 'system') {
    const head = { ...messagesFinal[0] } as WriterMessage;
    let i = 1;

    while (i < messagesFinal.length && messagesFinal[i]?.role === 'system') {
      const add = String((messagesFinal[i] as any)?.content ?? '').trim();
      if (add) {
        head.content = `${String(head.content ?? '').trim()}\n\n${add}`.trim();
      }
      i++;
    }

    if (i > 1) {
      messagesFinal = [head, ...messagesFinal.slice(i)];
    } else {
      messagesFinal[0] = head;
    }
  }

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

  return String(out ?? '').trim();
}
