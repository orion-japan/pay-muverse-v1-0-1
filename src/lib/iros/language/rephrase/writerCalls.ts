// =============================================
// file: src/lib/iros/language/rephrase/writerCalls.ts
// ✅ buildFirstPassMessages を「最後 user で終わる」ように拡張
// ✅ HistoryDigest v1 をここで注入できるようにする（唯一の choke point）
//
// ✅ 方針（今回の書き換え）:
// - user生文は「伏せない」：turns / historyForWriter 由来の user content を LLM に渡す
// - ただし安全のため、長さ上限と “内部マーカー” の除去だけはこの層で行う
//   （DO NOT OUTPUT 系や JSON 制御片が user 側に混入した場合の事故防止）
//
// ✅ 2026-03-05 change:
// - callWriterLLM の “[USER] マスク互換” を完全撤去
// - allowRawUserText は互換フィールドとして残すが、ここでは参照しない
// - 「全部 user を生で渡す（ただし strip/clamp は維持）」に統一
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

function clampStr(s: string, max: number) {
  const t = norm(s);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// user 側に “内部パック/制御マーカー” が混入した場合の事故防止（最低限）
function stripInternalMarkersFromUserText(s: string): string {
  let t = String(s ?? '');
  // 露出禁止ヘッダっぽい行を落とす（丸ごと隠すのではなく「制御片」だけ避ける）
  t = t.replace(
    /^(?:COORD|STATE_CUES_V3|CARDS_LITE_SEED|CARDS|INTERNAL PACK)\s*\(DO NOT OUTPUT\)\s*:?\s*$/gim,
    '',
  );
  // タグ行や明らかな制御行を軽く除去（過剰に消さない）
  t = t.replace(/^@(?:OBS|SHIFT|NEXT_HINT|SAFE)\b.*$/gim, '');
  return norm(t);
}

// mergeConsecutiveSameRole（内部パック境界を壊さない）
function mergeConsecutiveSameRole(messages: WriterMessage[]): WriterMessage[] {
  const out: WriterMessage[] = [];
  const normS = (s: any) => norm(String(s ?? ''));

  const isInternalPackLike = (s: string) =>
    /COORD\s*\(DO NOT OUTPUT\)|STATE_CUES_V3\s*\(DO NOT OUTPUT\)|CARDS_LITE_SEED\s*\(DO NOT OUTPUT\)|INTERNAL PACK\s*\(DO NOT OUTPUT\)|CARDS\s*\(DO NOT OUTPUT\)/i.test(
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

    // 同じroleが連続 → 結合（ただし内部パックっぽいassistantは境界として扱い、結合しない）
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
function ensureEndsWithUser(messages: WriterMessage[], finalUserText?: string): WriterMessage[] {
  const out = Array.isArray(messages) ? [...messages] : [];

  const normFinal = typeof finalUserText === 'string' ? norm(finalUserText) : '';
  const last = out[out.length - 1];

  // ✅ user で終わっていない場合は追加
  if (!last || last.role !== 'user') {
    out.push({ role: 'user', content: normFinal || '（入力なし）' });
    return out;
  }

  // placeholder上書き（finalUserText が渡った時だけ）
  if (normFinal) {
    const prev = norm(String(last.content ?? ''));
    if (prev === '（入力なし）' || prev.length === 0) {
      out[out.length - 1] = { role: 'user', content: normFinal };
    }
  }

  return out;
}

function turnsToMessages(
  turns: any,
  opts?: {
    maxTurnLen?: number;
    maxUserTurnLen?: number;
  },
): WriterMessage[] {
  const raw: any[] = Array.isArray(turns) ? turns : [];

  const MAX_TURN_LEN =
    typeof opts?.maxTurnLen === 'number' ? Math.max(50, opts!.maxTurnLen!) : 900;
  const MAX_USER_LEN =
    typeof opts?.maxUserTurnLen === 'number' ? Math.max(50, opts!.maxUserTurnLen!) : 900;

  const out: WriterMessage[] = [];

  for (const t of raw) {
    const role =
      t?.role === 'assistant'
        ? 'assistant'
        : t?.role === 'user'
          ? 'user'
          : null;

    if (!role) continue;

    const content0 = String(t?.content ?? t?.text ?? '').trim();
    if (!content0) continue;

    if (role === 'user') {
      const s0 = stripInternalMarkersFromUserText(content0);
      const s1 = clampStr(s0, MAX_USER_LEN);
      out.push({ role: 'user', content: s1 || '（入力なし）' });
      continue;
    }

    const a1 = clampStr(content0, MAX_TURN_LEN);
    if (!a1) continue;
    out.push({ role: 'assistant', content: norm(a1) });
  }

  return ensureEndsWithUser(mergeConsecutiveSameRole(out));
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
 * ✅ 1st pass: system + internalPack(as assistant) + turns
 * - 「最後は user で終わる」要件は turns の整形 + ensureEndsWithUser で満たす
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
  // ✅ COORD / CARDS / TEXT_SEED を internalPack の先頭に固定注入（露出禁止）
  // ------------------------------------------------------------

  const pick = (...vals: any[]) => {
    for (const v of vals) {
      const s0 =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : '';
      const s = norm(s0);
      if (s) return s;
    }
    return '';
  };

  const firstNonNull = <T,>(...vals: T[]): T | null => {
    for (const v of vals) if (v != null) return v;
    return null;
  };

  const normPolarity = (raw: any): { pol: 'yin' | 'yang' | ''; metaBand: string } => {
    let metaBand = '';

    const normOne = (x: any): 'yin' | 'yang' | '' => {
      const s = norm(
        typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
          ? String(x)
          : '',
      ).toLowerCase();

      if (!s) return '';
      if (s === 'yin' || s === '陰' || s === 'neg' || s === 'negative' || s === '-' || s === 'minus')
        return 'yin';
      if (s === 'yang' || s === '陽' || s === 'pos' || s === 'positive' || s === '+' || s === 'plus')
        return 'yang';
      return '';
    };

    if (raw && typeof raw === 'object') {
      const mb = pick(raw.metaBand, raw.polarityBand);
      metaBand = mb || '';
      const pol =
        normOne(raw.in) ||
        normOne(raw.out) ||
        normOne(raw.polarity) ||
        normOne(raw.polarityBand);
      return { pol, metaBand };
    }

    const pol = normOne(raw);
    return { pol, metaBand };
  };

  const normFutureHint = (raw: any): string => {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
      return norm(String(raw));
    if (typeof raw === 'object') {
      const s = pick(raw.hint, raw.label, raw.next, raw.text, raw.future, raw.value);
      return norm(s);
    }
    return '';
  };

  const normCardText = (raw: any): string => {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean')
      return norm(String(raw));
    if (typeof raw === 'object') {
      const s = pick(raw.shortText, raw.text, raw.cardId, raw.id, raw.meaningKey);
      return norm(s);
    }
    return '';
  };

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

  const phase = pick(args?.phase, ctxPack?.phase, extra?.phase);
  const eTurn = pick(args?.e_turn, args?.eTurn, ctxPack?.e_turn, ctxPack?.eTurn, extra?.e_turn, extra?.eTurn);

  const exprMeta = (args?.exprMeta ?? ctxPack?.exprMeta ?? extra?.exprMeta ?? null) as any;
  const saRhythm = pick(exprMeta?.rhythm, args?.sa?.rhythm, ctxPack?.sa?.rhythm);
  const saTone = pick(exprMeta?.tone, args?.sa?.tone, ctxPack?.sa?.tone);
  const saBrevity = pick(exprMeta?.brevity, args?.sa?.brevity, ctxPack?.sa?.brevity);

  const mirror = firstNonNull<any>(ctxPack?.mirror, extra?.mirror, (extra as any)?.ctxPack?.mirror, null);
  const polRaw = firstNonNull<any>(args?.polarity, mirror?.polarity, ctxPack?.polarity, extra?.polarity, null);
  const polN = normPolarity(polRaw);
  const polarity = polN.pol;

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
  const itxReason = pick(args?.itx_reason, ctxPack?.itx_reason, extra?.itx_reason, args?.itxReason, ctxPack?.itxReason);

  const future = firstNonNull<any>(args?.future, ctxPack?.future, extra?.future, null);
  const futureHint = normFutureHint(firstNonNull<any>(future, args?.futureHint, ctxPack?.futureHint, null));

  const cards = (args?.cards ?? ctxPack?.cards ?? extra?.cards ?? null) as any;
  const cardNow = normCardText(
    firstNonNull<any>(cards?.now, cards?.card_now, cards?.CARD_NOW, args?.cardNow, ctxPack?.cardNow, null),
  );
  const cardNext = normCardText(
    firstNonNull<any>(cards?.next, cards?.card_next, cards?.CARD_NEXT, args?.cardNext, ctxPack?.cardNext, null),
  );

  const coordLines: string[] = [];
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

    const saParts = [
      saTone && `tone=${saTone}`,
      saBrevity && `brevity=${saBrevity}`,
      saRhythm && `rhythm=${saRhythm}`,
    ]
      .filter(Boolean)
      .join(' ');
    if (saParts) coordLines.push(`sa=${saParts}`);

    const intentParts = [
      intentAnchor && `anchor=${intentAnchor}`,
      intentDir && `direction=${intentDir}`,
      itxStep && `itx_step=${itxStep}`,
      itxReason && `itx_reason=${itxReason}`,
    ]
      .filter(Boolean)
      .join(' ');
    if (intentParts) coordLines.push(`intent=${intentParts}`);

    const flowDelta = pick(flow?.delta, flow?.flowDelta);
    const returnStreak = pick(flow?.returnStreak, flow?.return_streak);
    const flowParts = [flowDelta && `delta=${flowDelta}`, returnStreak && `returnStreak=${returnStreak}`]
      .filter(Boolean)
      .join(' ');
    if (flowParts) coordLines.push(`flow=${flowParts}`);
    if (futureHint) coordLines.push(`future=${futureHint}`);
  }

  // NOTE: vNext — seed内で「CARDS/CARD_*」という語を使わない（占い感を避ける）
  // - current/next は STATE_CUES_V3 側で渡す
  const cardLines: string[] = [];

  const inputKindNow = String(
    pick(args?.inputKind, ctxPack?.inputKind, (ctxPack as any)?.input_kind, (extra as any)?.inputKind, (extra as any)?.input_kind) ??
      '',
  )
    .trim()
    .toLowerCase();

  const seedTextRaw = String(
    pick(
      (args as any)?.seed_text,
      (args as any)?.seedText,
      (ctxPack as any)?.seed_text,
      (ctxPack as any)?.seedText,
      (extra as any)?.seed_text,
      (extra as any)?.seedText,
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
      const add = (out.length ? 1 : 0) + line.length;
      if (len + add > maxLen) break;
      out.push(line);
      len += add;
    }
    while (out.length < 3) out.push('note=(none)');
    return out;
  };

  const flowDelta2 = String(pick(flow?.delta, (flow as any)?.flowDelta) ?? '').trim();
  const returnStreak2 = String(pick((flow as any)?.returnStreak, (flow as any)?.return_streak) ?? '').trim();

  // ------------------------------------------------------------
  // ✅ e_turn を「状態側(qCounts)」からも拾う（writerCalls入力に無いケースがある）
  // ※このスコープでは mirror2 / mirrorFlowV1 が無いので、ここで安全に組み立てる
  // ------------------------------------------------------------
  const mirrorAny: any =
    pick(
      (args as any)?.mirror,
      (args as any)?.flowMirror,
      (args as any)?.mirrorFlow,
      (ctxPack as any)?.mirror,
      (ctxPack as any)?.flowMirror,
      (extra as any)?.mirror,
      (extra as any)?.flowMirror,
      (ctxPack as any)?.mirrorFlowV1?.mirror,
      (args as any)?.mirrorFlowV1?.mirror,
      (extra as any)?.mirrorFlowV1?.mirror,
    ) ?? null;

  const mirrorFlowV1Any: any =
    pick(
      (args as any)?.mirrorFlowV1,
      (ctxPack as any)?.mirrorFlowV1,
      (extra as any)?.mirrorFlowV1,
    ) ?? null;

  const qCountsAny: any =
    pick(
      (ctxPack as any)?.resonanceState?.qCounts,
      (ctxPack as any)?.qCounts,
      (args as any)?.resonanceState?.qCounts,
      (args as any)?.qCounts,
      (extra as any)?.resonanceState?.qCounts,
      (extra as any)?.qCounts,
    ) ?? null;

  const eTurnNowFromCounts = pick(
    qCountsAny?.e_turn_now,
    qCountsAny?.eTurnNow,
    qCountsAny?.e_turn,
    qCountsAny?.eTurn,
  );

  const eTurn2 =
    norm(
      String(
        pick(
          (args as any)?.e_turn,
          (args as any)?.eTurn,
          mirrorAny?.e_turn,
          mirrorAny?.eTurn,
          mirrorFlowV1Any?.mirror?.e_turn,
          mirrorFlowV1Any?.mirror?.eTurn,
          eTurnNowFromCounts,
          '',
        ) ?? '',
      ),
    ) || '';

  // ------------------------------------------------------------
  // ✅ confidence（あれば拾う。無ければ空）
  // ------------------------------------------------------------
  const confidenceRaw = pick(
    (args as any)?.confidence,
    (ctxPack as any)?.confidence,
    (extra as any)?.confidence,
    mirrorAny?.confidence,
    mirrorAny?.mirrorConfidence,
    mirrorFlowV1Any?.confidence,
    mirrorFlowV1Any?.mirror?.confidence,
    mirrorFlowV1Any?.mirror?.mirrorConfidence,
  );

  const confidence =
    confidenceRaw != null && String(confidenceRaw).trim() !== '' ? String(confidenceRaw).trim() : '';

  // ------------------------------------------------------------
  // ✅ stateCore / currentLine / nextLine をこのスコープ内で確定させる
  // - 「card/cardId」等の語をseed側に出さない（値として入るのはOK）
  // ------------------------------------------------------------
  const seedLabel = seedTextRaw ? seedTextRaw.replace(/\s+/g, ' ').slice(0, 60) : '';

  const meaningBits: string[] = [];
  if (flowDelta2 === 'RETURN') meaningBits.push('いまは戻りの調整局面');
  else if (flowDelta2 === 'FORWARD') meaningBits.push('いまは前進を選べる局面');
  else if (flowDelta2) meaningBits.push(`流れ=${flowDelta2}`);
  if (returnStreak2) meaningBits.push(`戻り回数=${returnStreak2}`);

  if (qCode === 'Q3') meaningBits.push('不安を安定に寄せて整える');
  else if (qCode === 'Q2') meaningBits.push('引っかかりを成長に寄せてほどく');
  else if (qCode === 'Q1') meaningBits.push('秩序を保ちながら詰まりをほどく');
  else if (qCode === 'Q4') meaningBits.push('恐れを浄化に寄せて流す');
  else if (qCode === 'Q5') meaningBits.push('空虚を情熱に寄せて灯す');

  if (depthStage) meaningBits.push(`位置=${depthStage}`);
  if (phase) meaningBits.push(`位相=${phase}`);
  if (seedLabel) meaningBits.push(`補助=${seedLabel}`);

  const stateCore = (meaningBits.length > 0 ? meaningBits.join(' / ') : '(no_state_core)').slice(0, 160);

  // current/next は、既存の変数が無い前提で「拾えるところから拾う」
  const currentLine = String(
    pick(
      (args as any)?.cardNow,
      (args as any)?.card_now,
      (ctxPack as any)?.cardNow,
      (ctxPack as any)?.card_now,
      (extra as any)?.cardNow,
      (extra as any)?.card_now,
      (ctxPack as any)?.cards?.current,
      (args as any)?.cards?.current,
      (extra as any)?.cards?.current,
      (ctxPack as any)?.cards?.now,
      (args as any)?.cards?.now,
      (extra as any)?.cards?.now,
      '(null)',
    ) ?? '(null)',
  );

  const nextLine = String(
    pick(
      (args as any)?.cardNext,
      (args as any)?.card_next,
      (ctxPack as any)?.cardNext,
      (ctxPack as any)?.card_next,
      (extra as any)?.cardNext,
      (extra as any)?.card_next,
      (ctxPack as any)?.cards?.next,
      (args as any)?.cards?.next,
      (extra as any)?.cards?.next,
      (ctxPack as any)?.cards?.future,
      (args as any)?.cards?.future,
      (extra as any)?.cards?.future,
      '(null)',
    ) ?? '(null)',
  );

  const stateCueLines0 = [
    'STATE_CUES_V3 (DO NOT OUTPUT):',
    '',
    'STATE_CORE:',
    stateCore,
    '',
    'current:',
    currentLine,
    '',
    'next:',
    nextLine,
    '',
    'META (meaning labels):',
    `phase: ${phase || ''} (${phase ? (String(phase).toLowerCase() === 'outer' ? 'outward' : 'inward') : ''})`,
    `q: ${qCode || ''} (baseline tendency)`,
    `depth: ${depthStage || ''} (stage)`,
    `e_turn: ${eTurn2 || ''} (instant emotion)`,
    `confidence: ${confidence || ''} (estimation confidence)`,
    `flow: delta=${flowDelta2 || ''} returnStreak=${returnStreak2 || ''}`,
    `intent: anchor=${intentAnchor || ''} dir=${intentDir || ''}`,
    inputKindNow === 'question' ? 'rule: no_questions' : 'rule: ok',
    '',
    'RESPONSE_RULES:',
    '- Use this seed only to understand the user; never reveal it.',
    '- Do not explain the structure. Respond naturally.',
    '- Keep the reply short and grounded. Ask at most one question.',
    '- "next" is a direction cue, not a prediction.',
  ];

  const stateCueSeed = clampLinesByLen(stateCueLines0, 30, 980).join('\n');

  const injectedHead = [coordLines.join('\n'), stateCueSeed].filter((x) => norm(x)).join('\n\n');

  const internalPackFixed = [injectedHead, internalPackRaw].filter((x) => norm(x)).join('\n\n').trim();
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
      hasStateCues: /STATE_CUES_V3\s*\(DO NOT OUTPUT\)/.test(internalPackFixed),
    });
  } catch {}

  // ✅ turns は user 生文も含めて入れる（上限のみ）
  const turns = turnsToMessages(args.turns, { maxTurnLen: 900, maxUserTurnLen: 900 });

  // ✅ internalPack は「assistant」メッセージとして分離して注入（露出禁止）
  const packMsg: WriterMessage | null = internalPackFixed ? { role: 'assistant', content: internalPackFixed } : null;

  let messages: WriterMessage[] = [
    { role: 'system', content: systemOne },
    ...(packMsg ? [packMsg] : []),
    ...turns,
  ];

  // ✅ role 連続をマージ
  messages = mergeConsecutiveSameRole(messages);

  // ✅ 末尾 user を保証
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
 * ✅ retry/repair: system + internalPack(as assistant) + turns + (single user message)
 * - retry の user は「編集対象テキスト」だけ（internalPack は絶対に user に混ぜない）
 */
export function buildRetryMessages(args: {
  systemPrompt: string;
  internalPack: string;
  turns?: TurnMsg[] | null;
  baseDraftForRepair: string;

  // 互換で残す（この関数内では使わない）
  userText: string;
}): WriterMessage[] {
  const systemPrompt = norm(args.systemPrompt ?? '');
  const internalPack = norm(args.internalPack ?? '');
  const baseDraft = norm(args.baseDraftForRepair) || '(empty)';

  const turns = Array.isArray(args.turns) ? args.turns : [];
  const turnMsgs: WriterMessage[] = turns
    .map((t: any) => {
      const role = t?.role === 'assistant' ? 'assistant' : t?.role === 'user' ? 'user' : null;
      if (!role) return null;

      if (role === 'user') {
        const s0 = stripInternalMarkersFromUserText(String(t?.content ?? t?.text ?? ''));
        const s1 = clampStr(s0, 900);
        return { role: 'user', content: s1 || '（入力なし）' } as WriterMessage;
      }

      const a0 = norm(String(t?.content ?? t?.text ?? ''));
      const a1 = clampStr(a0, 900);
      return a1 ? ({ role: 'assistant', content: a1 } as WriterMessage) : null;
    })
    .filter(Boolean) as WriterMessage[];

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

  messages = mergeConsecutiveSameRole(messages);
  messages = foldLeadingSystemToOne(messages);
  messages = ensureEndsWithUser(messages);

  return messages;
}

// =============================================
// callWriterLLM
// =============================================
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

  // ✅ 追加：オウム返し除去ガード専用（比較に使う）
  echoGuardUserText?: string | null;

  // ✅ 互換で残す（この関数内では参照しない）
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

  // ✅ 全 user 生文を通す（ただし strip/clamp は維持）
  const MAX_USER = 900;
  const MAX_ASSIST = 900;

  messagesFinal = messagesFinal
    .map((m) => {
      if (!m) return m as any;

      if (m.role === 'user') {
        const s0 = stripInternalMarkersFromUserText(String(m.content ?? ''));
        const s1 = clampStr(s0, MAX_USER);
        return { role: 'user', content: s1 || '（入力なし）' } as WriterMessage;
      }

      if (m.role === 'assistant') {
        const a1 = clampStr(norm(m.content ?? ''), MAX_ASSIST);
        return a1 ? ({ role: 'assistant', content: a1 } as WriterMessage) : null;
      }

      // system はそのまま（正規化のみ）
      return { role: 'system', content: norm(m.content ?? '') } as WriterMessage;
    })
    .filter(Boolean) as WriterMessage[];

  // --- ここから：冒頭オウム返し除去ガード（比較用の raw は echoGuardUserText を優先） ---

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

  const lastUserRaw = String(args.echoGuardUserText ?? '');
  const lastUser = normHead(lastUserRaw);
  const lastUserFlat = normHeadFlat(lastUserRaw);

  const stripLeadingEcho = (outRaw: string) => {
    const outTrim = normHead(String(outRaw ?? ''));
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
