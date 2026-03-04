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
// writerCalls.ts に追加（ensureEndsWithUser より上）

// [置換] src/lib/iros/language/rephrase/writerCalls.ts
// 置換対象: function mergeConsecutiveSameRole(messages: WriterMessage[]): WriterMessage[] { ... } を丸ごと

function mergeConsecutiveSameRole(messages: WriterMessage[]): WriterMessage[] {
  const out: WriterMessage[] = [];
  const normS = (s: any) => norm(String(s ?? ''));

  const isInternalPackLike = (s: string) =>
    /COORD\s*\(DO NOT OUTPUT\)|TEXT_SEED\s*\(DO NOT OUTPUT\)|CARDS_LITE_SEED\s*\(DO NOT OUTPUT\)|INTERNAL PACK\s*\(DO NOT OUTPUT\)/i.test(
      s,
    );

  for (const m of messages) {
    if (!m) continue;
    const role = (m as any).role as WriterMessage['role'];
    const content = normS((m as any).content);

    if (!role) continue;

    // 空assistantは捨てる（念のため）
    if (role === 'assistant' && !content) continue;

    const last = out[out.length - 1];

    // 同じroleが連続 → 結合（ただし内部パックっぽいassistantは境界として扱い、絶対に結合しない）
    if (last && last.role === role) {
      if (
        role === 'assistant' &&
        (isInternalPackLike(normS(last.content)) || isInternalPackLike(content))
      ) {
        out.push({ role, content }); // boundary: no-merge
      } else {
        const merged = `${normS(last.content)}\n\n${content}`.trim();
        last.content = merged;
      }
    } else {
      out.push({ role, content });
    }
  }

  // assistant 空は弾く（念のため）
  return out.filter((m) => m.role !== 'assistant' || (m.content?.length ?? 0) > 0);
}

function turnsToMessages(
  turns: any,
  opts?: {
    // ✅ task のときだけ “最後の user” を生で渡す（それ以外は必ず [USER]）
    allowRawLastUser?: boolean;
    // 安全上限（task時のみ効く）
    maxLastUserLen?: number;
  },
): WriterMessage[] {
  const raw: any[] = Array.isArray(turns) ? turns : [];

  const allowRawLastUser = opts?.allowRawLastUser === true;
  const MAX_LAST_USER_LEN = typeof opts?.maxLastUserLen === 'number' ? opts!.maxLastUserLen! : 800;

  // ✅ 最後の user の index を探す（無ければ -1）
  let lastUserIdx = -1;
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i]?.role === 'user') {
      lastUserIdx = i;
      break;
    }
  }

  const out: WriterMessage[] = [];

  // ✅ task以外でも「短い最後user」は生で通す（質問を見失わないため）
  // - 過去userは引き続き [USER]
  // - 長文は引き続きマスク（安全）
  const MAX_LAST_USER_LEN_NON_TASK = 220;

  for (let i = 0; i < raw.length; i++) {
    const t = raw[i];

    const role =
      t?.role === 'assistant' ? 'assistant' :
      t?.role === 'user' ? 'user' :
      null;

    if (!role) continue;

    if (role === 'user') {
      const isLast = i === lastUserIdx;

      if (isLast) {
        const s0 = String(t?.content ?? '').trim();
        const limit = allowRawLastUser ? MAX_LAST_USER_LEN : MAX_LAST_USER_LEN_NON_TASK;
        const s1 = s0.length > limit ? s0.slice(0, limit) : s0;

        // last user は（短文化した上で）常に渡す。空なら placeholder。
        out.push({ role: 'user', content: norm(s1) || '（入力なし）' });
      } else {
        // 過去userは伏せる
        out.push({ role: 'user', content: '[USER]' });
      }
      continue;
    }

    // assistant はそのまま
    const content = String(t?.content ?? '').trim();
    if (!content) continue;
    out.push({ role: 'assistant', content: norm(content) });
  }

  // ✅ 最後は user で終わらせる（要件維持）
  return ensureEndsWithUser(mergeConsecutiveSameRole(out));
}

function ensureEndsWithUser(messages: WriterMessage[], finalUserText?: string): WriterMessage[] {
  const out = Array.isArray(messages) ? [...messages] : [];

  const normFinal = typeof finalUserText === 'string' ? norm(finalUserText) : '';
  const last = out[out.length - 1];

  // ✅ user で終わっていない場合は追加
  // - 正本：task以外は常に [USER]
  // - taskで raw を入れたい場合は finalUserText を渡す側が責務を持つ
  if (!last || last.role !== 'user') {
    out.push({ role: 'user', content: normFinal || '[USER]' });
    return out;
  }

  // ✅ user で終わっている場合、placeholderなら上書き（taskなどで finalUserText が渡った時だけ）
  if (normFinal) {
    const prev = norm(String(last.content ?? ''));
    if (prev === '[USER]' || prev === '（入力なし）' || prev.length === 0) {
      out[out.length - 1] = { role: 'user', content: normFinal };
    }
  }

  return out;
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

  // ✅ ここで args の形を確証（長すぎる場合に備えてキーのみ）
  try {
    const keys = Object.keys(args ?? {}).sort();
    console.log('[IROS/writerCalls][ARGS_KEYS]', { keys });
  } catch {}

  const conversationLineBlock = [topicDigest, conversationLine]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n');

  // ✅ system は「軽量」に固定（PDFの上限設計に合わせる）
  // - internalPack は system に混ぜない（systemLen が肥大化するため）
  const systemOne = [
    systemPrompt,
    conversationLineBlock ? `CONVERSATION_LINE (DO NOT OUTPUT):\n${conversationLineBlock}` : '',
  ]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n\n');

  // ------------------------------------------------------------
  // ✅ COORD / CARDS を internalPack の先頭に固定注入（露出禁止）
  // - args に来ている情報だけを使う（無ければ空）
  // - まずは「必ず同じ場所に入る」ことを優先（次のターンでソースを確定して強化）
  // ------------------------------------------------------------

  const pick = (...vals: any[]) => {
    for (const v of vals) {
      // ✅ COORD用：object を誤って拾わない（"[object Object]"事故を防ぐ）
      const s0 =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
      const s = norm(s0);
      if (s) return s;
    }
    return '';
  };

  const firstNonNull = <T,>(...vals: T[]): T | null => {
    for (const v of vals) if (v != null) return v;
    return null;
  };

  const normPolarity = (
    raw: any,
  ): { pol: 'yin' | 'yang' | ''; metaBand: string } => {
    // raw can be:
    // - "yin"/"yang"/"陰"/"陽"/"positive"/"negative"
    // - { in, out, metaBand } or { polarityBand } etc.
    let metaBand = '';

    const normOne = (x: any): 'yin' | 'yang' | '' => {
      const s = norm(
        typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean' ? String(x) : '',
      ).toLowerCase();

      if (!s) return '';
      if (s === 'yin' || s === '陰' || s === 'neg' || s === 'negative' || s === '-' || s === 'minus') return 'yin';
      if (s === 'yang' || s === '陽' || s === 'pos' || s === 'positive' || s === '+' || s === 'plus') return 'yang';
      return '';
    };

    if (raw && typeof raw === 'object') {
      // metaBand / polarityBand などは「表示用の帯」として保持（yin/yang とは別）
      const mb = pick(raw.metaBand, raw.polarityBand);
      metaBand = mb || '';
      const pol = normOne(raw.in) || normOne(raw.out) || normOne(raw.polarity) || normOne(raw.polarityBand);
      return { pol, metaBand };
    }

    const pol = normOne(raw);
    return { pol, metaBand };
  };

  const normFutureHint = (raw: any): string => {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return norm(String(raw));
    if (typeof raw === 'object') {
      // label/hint/next/text を優先して 1行化
      const s = pick(raw.hint, raw.label, raw.next, raw.text, raw.future, raw.value);
      return norm(s);
    }
    return '';
  };

  const normCardText = (raw: any): string => {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return norm(String(raw));
    if (typeof raw === 'object') {
      // cardId/shortText/text あたりを優先して短文化
      const s = pick(raw.shortText, raw.text, raw.cardId, raw.id, raw.meaningKey);
      return norm(s);
    }
    return '';
  };

  // 候補: 直接 / ctxPack / meta / memoryState 的な入れ物を広く拾う（存在しない場合は空）
  const ctxPack = (args?.ctxPack ?? args?.ctx_pack ?? args?.meta?.extra?.ctxPack ?? null) as any;
  const extra = (args?.extra ?? args?.meta?.extra ?? null) as any;
  const flow = (args?.flow ?? ctxPack?.flow ?? extra?.flow ?? null) as any;

  const qCode = pick(args?.qCode, args?.q_code, ctxPack?.qCode, ctxPack?.q_code, extra?.qCode, extra?.q_code);
  const depthStage = pick(
    args?.depthStage,
    args?.depth_stage,
    ctxPack?.depthStage,
    ctxPack?.depth_stage,
    extra?.depthStage,
    extra?.depth_stage,
  );

  // phase(Inner/Outer) は既にある前提。
  const phase = pick(args?.phase, ctxPack?.phase, extra?.phase);

  // e_turn（instant）は optional
  const eTurn = pick(args?.e_turn, args?.eTurn, ctxPack?.e_turn, ctxPack?.eTurn, extra?.e_turn, extra?.eTurn);

  // sa / exprMeta（表現の間合い）: あるものだけ短く投影
  const exprMeta = (args?.exprMeta ?? ctxPack?.exprMeta ?? extra?.exprMeta ?? null) as any;
  const saRhythm = pick(exprMeta?.rhythm, args?.sa?.rhythm, ctxPack?.sa?.rhythm);
  const saTone = pick(exprMeta?.tone, args?.sa?.tone, ctxPack?.sa?.tone);
  const saBrevity = pick(exprMeta?.brevity, args?.sa?.brevity, ctxPack?.sa?.brevity);

  // ✅ polarity は object が来るので “専用正規化” で必ず yin/yang に落とす
  const mirror = firstNonNull<any>(ctxPack?.mirror, extra?.mirror, (extra as any)?.ctxPack?.mirror, null);
  const polRaw = firstNonNull<any>(args?.polarity, mirror?.polarity, ctxPack?.polarity, extra?.polarity, null);
  const polN = normPolarity(polRaw);
  const polarity = polN.pol; // 'yin' | 'yang' | ''

  // intent（SUN + direction / itx）
  const intent = (args?.intent ?? ctxPack?.intent ?? extra?.intent ?? null) as any;
  const intentAnchor = pick(
    intent?.anchor,
    intent?.intentAnchor,
    args?.intentAnchor,
    ctxPack?.intentAnchor,
    extra?.intentAnchor,
  );
  const intentDir = pick(intent?.direction, args?.intentDirection, ctxPack?.intentDirection, extra?.intentDirection);
  const itxStep = pick(args?.itx_step, ctxPack?.itx_step, extra?.itx_step, args?.itxStep, ctxPack?.itxStep);
  const itxReason = pick(
    args?.itx_reason,
    ctxPack?.itx_reason,
    extra?.itx_reason,
    args?.itxReason,
    ctxPack?.itxReason,
  );

  // ✅ 未来観測（objectも吸収して1行化）
  const future = firstNonNull<any>(args?.future, ctxPack?.future, extra?.future, null);
  const futureHint = normFutureHint(firstNonNull<any>(future, args?.futureHint, ctxPack?.futureHint, null));

  // カード（現在/未来）: objectも吸収して短文化
  const cards = (args?.cards ?? ctxPack?.cards ?? extra?.cards ?? null) as any;
  const cardNow = normCardText(firstNonNull<any>(cards?.now, cards?.card_now, cards?.CARD_NOW, args?.cardNow, ctxPack?.cardNow, null));
  const cardNext = normCardText(firstNonNull<any>(cards?.next, cards?.card_next, cards?.CARD_NEXT, args?.cardNext, ctxPack?.cardNext, null));

  const coordLines: string[] = [];
  // 露出禁止の宣言ブロック
  if (
    qCode ||
    depthStage ||
    phase ||
    polarity ||
    eTurn ||
    saRhythm ||
    saTone ||
    saBrevity ||
    intentAnchor ||
    intentDir ||
    itxStep ||
    itxReason ||
    futureHint
  ) {
    coordLines.push('COORD (DO NOT OUTPUT):');
    if (eTurn) coordLines.push(`e_turn=${eTurn}`);
    if (depthStage) coordLines.push(`depthStage=${depthStage}`);
    if (qCode) coordLines.push(`qCode=${qCode}`);
    if (polarity) coordLines.push(`polarity=${polarity}`);
    if (polN.metaBand) coordLines.push(`polarity_metaBand=${polN.metaBand}`);
    if (phase) coordLines.push(`phase=${phase}`);

    // sa を短く（空配列事故を避ける）
    const saParts = [saTone && `tone=${saTone}`, saBrevity && `brevity=${saBrevity}`, saRhythm && `rhythm=${saRhythm}`]
      .filter(Boolean)
      .join(' ');
    if (saParts) coordLines.push(`sa=${saParts}`);

    // intent
    const intentParts = [
      intentAnchor && `anchor=${intentAnchor}`,
      intentDir && `direction=${intentDir}`,
      itxStep && `itx_step=${itxStep}`,
      itxReason && `itx_reason=${itxReason}`,
    ]
      .filter(Boolean)
      .join(' ');
    if (intentParts) coordLines.push(`intent=${intentParts}`);

    // flow / future
    const flowDelta = pick(flow?.delta, flow?.flowDelta);
    const returnStreak = pick(flow?.returnStreak, flow?.return_streak);
    const flowParts = [flowDelta && `delta=${flowDelta}`, returnStreak && `returnStreak=${returnStreak}`]
      .filter(Boolean)
      .join(' ');
    if (flowParts) coordLines.push(`flow=${flowParts}`);
    if (futureHint) coordLines.push(`future=${futureHint}`);
  }

  const cardLines: string[] = [];
  if (cardNow || cardNext) {
    cardLines.push('CARDS (DO NOT OUTPUT):');
    if (cardNow) cardLines.push(`CARD_NOW: ${cardNow}`);
    if (cardNext) cardLines.push(`CARD_NEXT: ${cardNext}`);
  }

  // =========================
  // ✅ TEXT_SEED v1（DO NOT OUTPUT）
  // - user生文は渡さない前提で、LLMが“今回の意味”を掴むための最小seed
  // - 3〜6行 / 最大320文字
  // =========================
  const inputKindNow = String(
    pick(args?.inputKind, ctxPack?.inputKind, ctxPack?.input_kind, extra?.inputKind, extra?.input_kind) ?? '',
  )
    .trim()
    .toLowerCase();

  const seedTextRaw = String(
    pick(
      (args as any)?.seed_text,
      (args as any)?.seedText,
      ctxPack?.seed_text,
      ctxPack?.seedText,
      extra?.seed_text,
      extra?.seedText,
      '',
    ) ?? '',
  ).trim();

  const clampLinesByLen = (lines: string[], maxLines: number, maxLen: number) => {
    const out: string[] = [];
    let len = 0;
    for (const line0 of lines) {
      const line = norm(line0);
      if (!line) continue;
      if (out.length >= maxLines) break;
      const add = (out.length ? 1 : 0) + line.length; // +1 = '\n'
      if (len + add > maxLen) break;
      out.push(line);
      len += add;
    }
    // 最低3行は欲しい（足りない場合は埋める）
    while (out.length < 3) out.push('note=(none)');
    return out;
  };

  // ✅ flow はここで一回だけ正規化（重複排除）
  const flowDelta2 = String(pick(flow?.delta, flow?.flowDelta) ?? '').trim();
  const returnStreak2 = String(pick(flow?.returnStreak, flow?.return_streak) ?? '').trim();

  // ✅ obs は “意味seed” を優先して作る（ラベルだけにしない）
  const seedLabel = seedTextRaw ? seedTextRaw.replace(/\s+/g, ' ').slice(0, 60) : '';
  const fHint = futureHint ? String(futureHint).replace(/\s+/g, ' ').slice(0, 80) : '';

  const meaningBits: string[] = [];

  // flow を短い意味に（推測でストーリー化しない）
  if (flowDelta2 === 'RETURN') meaningBits.push('いまは戻りの調整局面');
  else if (flowDelta2 === 'FORWARD') meaningBits.push('いまは前進を選べる局面');
  else if (flowDelta2) meaningBits.push(`流れ=${flowDelta2}`);

  if (returnStreak2) meaningBits.push(`戻り回数=${returnStreak2}`);

  // Q を短い意味に（1フレーズ固定 / 一般論で膨らませない）
  if (qCode === 'Q3') meaningBits.push('不安を安定に寄せて整える');
  else if (qCode === 'Q2') meaningBits.push('引っかかりを成長に寄せてほどく');
  else if (qCode === 'Q1') meaningBits.push('秩序を保ちながら詰まりをほどく');
  else if (qCode === 'Q4') meaningBits.push('恐れを浄化に寄せて流す');
  else if (qCode === 'Q5') meaningBits.push('空虚を情熱に寄せて灯す');

  // depth / phase は“位置”としてだけ使う
  if (depthStage) meaningBits.push(`位置=${depthStage}`);
  if (phase) meaningBits.push(`位相=${phase}`);

  // futureHint があれば、見通しとして 1つだけ
  if (fHint) meaningBits.push(`見通し=${fHint}`);

  // seed_text は最後に補助で添える（主役にしない）
  if (seedLabel) meaningBits.push(`補助=${seedLabel}`);

  const seedObs = (meaningBits.length > 0 ? meaningBits.join(' / ') : '(no_meaning_seed)').slice(0, 140);

  const seedLines0 = [
    'TEXT_SEED (DO NOT OUTPUT):',
    `obs=${seedObs}`,
    `coord=q=${qCode || ''} depth=${depthStage || ''} phase=${phase || ''} pol=${polarity || ''}`,
    `flow=delta=${flowDelta2 || ''} returnStreak=${returnStreak2 || ''}`,
    `intent=anchor=${intentAnchor || ''} dir=${intentDir || ''}`,
    inputKindNow === 'question' ? 'rule=no_questions' : 'rule=ok',
  ];

  const seedLines = clampLinesByLen(seedLines0, 6, 320).join('\n');

  const injectedHead = [coordLines.join('\n'), cardLines.join('\n'), seedLines]
    .filter((x) => norm(x))
    .join('\n\n');

  // internalPack 先頭に固定注入（internalPack が空なら injectedHead のみ）
  const internalPackFixed = [injectedHead, internalPackRaw].filter((x) => norm(x)).join('\n\n').trim();

  // ✅ 確証ログ：COORD/CARDS/TEXT_SEED 注入 “後” の head を見る（ここが正本）
  try {
    const h = norm(internalPackFixed).slice(0, 420);
    console.log('[IROS/writerCalls][INJECTED_PACK_HEAD]', {
      traceId: (args as any)?.traceId ?? null,
      conversationId: (args as any)?.conversationId ?? null,
      packLen: norm(internalPackFixed).length,
      head: h,
      hasCOORD: /COORD\s*\(DO NOT OUTPUT\)/.test(internalPackFixed),
      hasPolarity: /polarity=/.test(internalPackFixed),
      hasSA: /sa=/.test(internalPackFixed),
      hasITX: /itx_step=|itx_reason=/.test(internalPackFixed),
      hasFuture: /future=/.test(internalPackFixed),
      hasTextSeed: /TEXT_SEED\s*\(DO NOT OUTPUT\)/.test(internalPackFixed),
    });
  } catch {}

  // ✅ turns は user をマスクしたうえで追加
  const turns = turnsToMessages(args.turns);

  try {
    console.log('[IROS/writerCalls][SYSTEM_ONE_LEN]', {
      systemPromptLen: norm(systemPrompt).length,
      conversationLineBlockLen: norm(conversationLineBlock).length,
      systemOneLen: norm(systemOne).length,
      systemOneHead: norm(systemOne).slice(0, 140),
    });
  } catch {}

  // ✅ internalPack は「assistant」メッセージとして分離して注入（露出禁止）
  const packMsg: WriterMessage | null = internalPackFixed ? { role: 'assistant', content: internalPackFixed } : null;

  let messages: WriterMessage[] = [
    { role: 'system', content: systemOne },
    ...(packMsg ? [packMsg] : []),
    ...turns,
  ];

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

  const turns = Array.isArray(args.turns) ? args.turns : [];
  const turnMsgs: WriterMessage[] = turns
    .map((t: any) => ({
      role: (t?.role ?? 'assistant') as any,
      content: norm(t?.content ?? t?.text ?? ''),
    }))
    .filter((m) => m?.content && String(m.content).trim().length > 0);

  // ✅ retry の user は「編集対象テキスト」だけ（internalPack は絶対に user に混ぜない）
  let messages: WriterMessage[] = [
    { role: 'system', content: systemPrompt },
    ...(internalPack
      ? [
          {
            role: 'assistant',
            content: `INTERNAL PACK (DO NOT OUTPUT):\n${internalPack}`.trim(),
          } as WriterMessage,
        ]
      : []),
    ...turnMsgs,
    { role: 'user', content: baseDraft },
  ];

  // ✅ role 連続をマージ（保険）
  messages = mergeConsecutiveSameRole(messages);

  // ✅ 先頭 system は 1枚に畳む
  messages = foldLeadingSystemToOne(messages);

  // ✅ 末尾 user を保証
  messages = ensureEndsWithUser(messages);

  return messages;
}
// src/lib/iros/language/rephrase/writerCalls.ts
// 置換範囲：export async function callWriterLLM(...) { ... } を丸ごと

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

  // ✅ 追加：オウム返し除去ガード専用（LLMには渡さない、比較にだけ使う）
  // - user生文を messages に入れないまま、stripLeadingEcho の比較だけ可能にする
  echoGuardUserText?: string | null;

  // ✅ 追加：task のときだけ “user原文” を許可（未指定なら自動判定を試みる）
  allowRawUserText?: boolean | null;
}): Promise<string> {
  // ✅ HistoryDigest v1 を注入（ある時だけ）
  const digest = (args.historyDigestV1 ?? null) as HistoryDigestV1 | null;
  const injected = digest ? (injectHistoryDigestV1({ messages: args.messages, digest }) as any) : null;

  let messagesFinal: WriterMessage[] = (injected?.messages ?? args.messages) as WriterMessage[];

  // ✅ 先頭 system は 1枚に畳む
  messagesFinal = foldLeadingSystemToOne(messagesFinal);

  // ✅ 末尾 user を保証（念のため）
  messagesFinal = ensureEndsWithUser(messagesFinal);

  // ============================================================
  // ✅ [最終仕様] user入力ポリシー（PDF正本）
  // - task 以外は role=user の content を必ず "[USER]" に固定
  // - task のときだけ raw を許可（ただし echoGuard で比較は継続）
  // ============================================================

  const detectInputKindFromMessages = (msgs: WriterMessage[]) => {
    // system / assistant に混ざる inputKind ヒントから拾う（推測でなく“埋め込み”のみ）
    const texts: string[] = [];
    for (const m of msgs) {
      if (!m?.content) continue;
      if (m.role === 'system' || m.role === 'assistant') texts.push(String(m.content));
    }
    const blob = texts.join('\n');

    // 例: "inputKind=task" / "inputKind: task" を吸収
    const m1 = blob.match(/\binputKind\b\s*[:=]\s*([A-Za-z_][A-Za-z0-9_]*)/i);
    if (m1?.[1]) return String(m1[1]).trim().toLowerCase();

    return '';
  };

  const inputKindFromAudit = String((args.audit as any)?.inputKind ?? '').trim().toLowerCase();
  const inputKindFromExtra = String((args.extraBody as any)?.inputKind ?? '').trim().toLowerCase();
  const inputKindFromMsgs = detectInputKindFromMessages(messagesFinal);

  const inputKind =
    inputKindFromAudit ||
    inputKindFromExtra ||
    inputKindFromMsgs ||
    '';

    const allowRawUser =
    typeof args.allowRawUserText === 'boolean'
      ? args.allowRawUserText
      : inputKind === 'task';

  // ✅ 非taskでも「最後の user だけ」は短く生で渡す（質問の核を落とさないため）
  // - 過去userは常に [USER]
  // - task は従来どおり raw 許可（ただし後段の echoGuard 比較は継続）
  const MAX_LAST_USER_LEN_NON_TASK = 220;
  const MAX_LAST_USER_LEN_TASK = 800;

  const findLastUserIdx = (msgs: WriterMessage[]) => {
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user') return i;
    return -1;
  };

  const sanitizeUserMessages = (msgs: WriterMessage[]) => {
    const lastUserIdx = findLastUserIdx(msgs);

    return msgs.map((m, idx) => {
      if (!m) return m as any;
      if (m.role !== 'user') return m;

      // task：最後userは生（上限付き）、それ以外は [USER]
      if (allowRawUser) {
        if (idx === lastUserIdx) {
          const s0 = String(m?.content ?? '').trim();
          const s1 = s0.length > MAX_LAST_USER_LEN_TASK ? s0.slice(0, MAX_LAST_USER_LEN_TASK) : s0;
          return { role: 'user', content: s1 || '（入力なし）' } as WriterMessage;
        }
        return { role: 'user', content: '[USER]' } as WriterMessage;
      }

      // 非task：最後userだけ短く生、過去userは [USER]
      if (idx === lastUserIdx) {
        const s0 = String(m?.content ?? '').trim();
        const s1 =
          s0.length > MAX_LAST_USER_LEN_NON_TASK ? s0.slice(0, MAX_LAST_USER_LEN_NON_TASK) : s0;
        return { role: 'user', content: s1 || '[USER]' } as WriterMessage;
      }
      return { role: 'user', content: '[USER]' } as WriterMessage;
    });
  };

  messagesFinal = sanitizeUserMessages(messagesFinal);
  // --- ここから：冒頭オウム返し除去ガード（モデル非依存の確定対策） ---

  const normHead = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

  const normHeadFlat = (s: string) =>
    String(s ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();

  // ✅ 重要：比較用の生文は echoGuardUserText だけ（messages から拾わない）
  const lastUserRaw = String(args.echoGuardUserText ?? '');
  const lastUser = normHead(lastUserRaw);
  const lastUserFlat = normHeadFlat(lastUserRaw);

  const stripLeadingEcho = (outRaw: string) => {
    let out = String(outRaw ?? '');
    const outTrim = normHead(out);

    if (!outTrim || !lastUser) return norm(outTrim);

    const firstLine = normHead(outTrim.split('\n')[0] ?? '');
    const firstLineFlat = normHeadFlat(firstLine);

    const looksEcho =
      (firstLine.length >= 8 && (lastUser === firstLine || lastUser.startsWith(firstLine))) ||
      (firstLineFlat.length >= 8 && (lastUserFlat === firstLineFlat || lastUserFlat.startsWith(firstLineFlat)));

    if (!looksEcho) return norm(outTrim);

    let lines = outTrim.split('\n');
    lines.shift();
    while (lines.length && !normHead(lines[0] ?? '')) lines.shift();

    const cleaned = normHead(lines.join('\n'));
    return cleaned ? norm(cleaned) : norm(outTrim);
  };

  // --- ここまで：冒頭オウム返し除去ガード ---

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
    audit: args.audit ?? null,
    trace: {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },
  });

  return stripLeadingEcho(out ?? '');
}
