// =============================================
// file: src/lib/iros/language/rephrase/writerCalls.ts
// ✅ buildFirstPassMessages を「最後 user で終わる」ように拡張
// ✅ HistoryDigest v1 をここで注入できるようにする（唯一の choke point）
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
  let turns = turnsToMessages(args.turns);
  const finalUserText = norm(args.finalUserText ?? '');

  const out: WriterMessage[] = [{ role: 'system', content: systemPrompt }];

  // ✅ internalPack は system の直後に置きたいが、
  // turns が user で始まると user,user が起きるため “合体” する
  if (internalPack) {
    const first = turns[0];
    if (first?.role === 'user') {
      const merged = [internalPack, norm(first.content)].filter((x) => x.trim().length > 0).join('\n\n');
      turns = [{ role: 'user', content: merged }, ...turns.slice(1)];
    } else {
      out.push({ role: 'user', content: internalPack });
    }
  }

  // 直近ターン（会話の流れ）
  // - ✅ user,user / assistant,assistant の連続を作らない（品質低下と同文返しの要因）
  for (const m of turns) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      // “後勝ちで圧縮” ではなく、文脈を落とさないためにマージ
      last.content = `${last.content}\n\n${m.content}`.trim();
    } else {
      out.push(m);
    }
  }


  // ✅ 最後を user で終わらせる（ただし user,user 連投は絶対に作らない）
  // - 末尾が user の場合は “追記マージ” or “置換” を状況で切り替える
  if (finalUserText) {
    const last = out[out.length - 1];

    if (last?.role === 'user') {
      const lastNorm = norm(last?.content);

      // ✅ すでに同一なら何もしない
      if (lastNorm === finalUserText) {
        // noop
      } else if (
        // ✅ finalUserText が末尾 userText を内包しているなら「置換」して重複を防ぐ
        // 例: lastNorm = "今日は...24"
        //     finalUserText = "今日は...24\n流れを保ったまま前に進める"
        finalUserText.includes(lastNorm)
      ) {
        (out[out.length - 1] as WriterMessage).content = finalUserText;
      } else {
        // 従来通り：文脈を落とさないために追記
        if (!lastNorm.includes(finalUserText)) {
          (out[out.length - 1] as WriterMessage).content =
            `${lastNorm}\n\n${finalUserText}`.trim();
        }
      }
    } else {
      out.push({ role: 'user', content: finalUserText });
    }
  }
  return out;
}

/**
 * ✅ retry/repair: system + turns + (internalPack as user) + repair-instruction + userText
 * - internalPack を system にしない（system 増殖を止める）
 * - “編集タスク” は user で渡す
 */
/**
 * ✅ retry/repair: system + turns + (single user message)
 * - user の連投を避ける（品質低下・同文返しの要因）
 * - internalPack / 編集対象 / userText を 1つの user メッセージに統合
 */
export function buildRetryMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;
  baseDraftForRepair: string;
  userText: string;
}): WriterMessage[] {
  const systemPrompt = String(args.systemPrompt ?? '');
  const internalPack = norm(args.internalPack ?? '');
  const baseDraft = norm(args.baseDraftForRepair) || '(empty)';
  const userText = norm(args.userText) || '（空）';

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
      '【ユーザー入力（文脈）】',
      userText,
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
    trace: {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },
    audit: {
      ...(args.audit ?? {}),
      historyDigestV1: digest ? { injected: true, chars: injected?.digestChars ?? null } : { injected: false },
      systemCollapsed: true,
      systemHeadCountBefore:
        Array.isArray((injected?.messages ?? args.messages))
          ? (injected?.messages ?? args.messages).filter((m: any, idx: number) => idx < 12 && m?.role === 'system').length
          : null,
      systemHeadCountAfter: messagesFinal.slice(0, 12).filter((m) => m?.role === 'system').length,
    },
  } as any);

  return String(out ?? '');
}
