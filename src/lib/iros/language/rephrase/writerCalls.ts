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
import { decideRecallV1 } from '../../memory/recallGate';
import { buildFlowMeaningV1 } from '../../memory/buildFlowMeaning';
import { buildMirrorFlowSeed, formatMirrorFlowSeed } from '../../seed/seedEngine';

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

  // ✅ user で終わっていない場合は、finalUserText がある時だけ追加
  if (!last || last.role !== 'user') {
    if (normFinal) out.push({ role: 'user', content: normFinal });
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
      if (!s1) continue;
      out.push({ role: 'user', content: s1 });
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
  const topicDigest = clampStr(norm(args.topicDigest ?? ''), 260);
  const conversationLine = clampStr(norm(args.conversationLine ?? ''), 260);
  const internalPackRaw = norm(args.internalPack ?? '');
  const topicDigestV2Raw =
    args.topicDigestV2 && typeof args.topicDigestV2 === 'object'
      ? args.topicDigestV2
      : null;

  const outputPolicyRaw =
    args.outputPolicy && typeof args.outputPolicy === 'object'
      ? args.outputPolicy
      : null;

  const topicDigestV2Block = topicDigestV2Raw
    ? clampStr(
        JSON.stringify(
          {
            mainTopic:
              typeof topicDigestV2Raw.mainTopic === 'string'
                ? topicDigestV2Raw.mainTopic
                : null,
            subTopic:
              typeof topicDigestV2Raw.subTopic === 'string'
                ? topicDigestV2Raw.subTopic
                : null,
            summary:
              typeof topicDigestV2Raw.summary === 'string'
                ? topicDigestV2Raw.summary
                : null,
            keywords: Array.isArray(topicDigestV2Raw.keywords)
              ? topicDigestV2Raw.keywords
              : [],
          },
          null,
          0,
        ),
        500,
      )
    : '';

  const outputPolicyBlock = outputPolicyRaw
    ? clampStr(
        JSON.stringify(
          {
            answerFirst:
              outputPolicyRaw.answerFirst === true,
            askBackAllowed:
              outputPolicyRaw.askBackAllowed === true,
            questions_max:
              typeof args.questions_max === 'number'
                ? args.questions_max
                : null,
          },
          null,
          0,
        ),
        220,
      )
    : '';

  const conversationLineBlock = [topicDigest, conversationLine]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n');

  const conversationLineBlockClamped = clampStr(conversationLineBlock, 360);

  const systemOne = [
    systemPrompt,
    conversationLineBlockClamped
      ? `CONVERSATION_LINE (DO NOT OUTPUT):\n${conversationLineBlockClamped}`
      : '',
    topicDigestV2Block
      ? `TOPIC_DIGEST_V2 (DO NOT OUTPUT):\n${topicDigestV2Block}`
      : '',
    outputPolicyBlock
      ? `OUTPUT_POLICY_V1 (DO NOT OUTPUT):\n${outputPolicyBlock}`
      : '',
  ]
    .map((x) => norm(x))
    .filter((x) => x.length > 0)
    .join('\n\n');

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
      if (
        s === 'yin' ||
        s === '陰' ||
        s === 'neg' ||
        s === 'negative' ||
        s === '-' ||
        s === 'minus'
      ) {
        return 'yin';
      }
      if (
        s === 'yang' ||
        s === '陽' ||
        s === 'pos' ||
        s === 'positive' ||
        s === '+' ||
        s === 'plus'
      ) {
        return 'yang';
      }
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
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return norm(String(raw));
    }
    if (typeof raw === 'object') {
      const s = pick(raw.hint, raw.label, raw.next, raw.text, raw.future, raw.value);
      return norm(s);
    }
    return '';
  };

  const normFlowText = (raw: any): string => {
    if (raw == null) return '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      return norm(String(raw));
    }
    if (typeof raw === 'object') {
      const s = pick(raw.shortText, raw.text, raw.flowId, raw.cardId, raw.id, raw.meaningKey);
      return norm(s);
    }
    return '';
  };

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

  const ctxPack = (args?.ctxPack ?? args?.ctx_pack ?? args?.meta?.extra?.ctxPack ?? null) as any;
  const extra = (args?.extra ?? args?.meta?.extra ?? null) as any;
  const flow = (args?.flow ?? ctxPack?.flow ?? extra?.flow ?? null) as any;

  const qCode = pick(
    args?.qCode,
    args?.q_code,
    ctxPack?.qCode,
    ctxPack?.q_code,
    extra?.qCode,
    extra?.q_code,
  );

  const depthStage = pick(
    args?.depthStage,
    args?.depth_stage,
    ctxPack?.depthStage,
    ctxPack?.depth_stage,
    extra?.depthStage,
    extra?.depth_stage,
  );

  const phase = pick(args?.phase, ctxPack?.phase, extra?.phase);

  const cardsAny: any = firstNonNull(
    (ctxPack as any)?.cards,
    (extra as any)?.ctxPack?.cards,
    (extra as any)?.cards,
    null,
  );
  const currentCardAny: any = firstNonNull(
    cardsAny?.currentCard,
    cardsAny?.current,
    null,
  );

  const mirrorFlowV1ForSeed: any =
    pick(
      (args as any)?.mirrorFlowV1,
      (ctxPack as any)?.mirrorFlowV1,
      (extra as any)?.mirrorFlowV1,
    ) ?? null;

  const qCountsForSeed: any =
    pick(
      (ctxPack as any)?.resonanceState?.qCounts,
      (ctxPack as any)?.qCounts,
      (args as any)?.resonanceState?.qCounts,
      (args as any)?.qCounts,
      (extra as any)?.resonanceState?.qCounts,
      (extra as any)?.qCounts,
    ) ?? null;

  const mirror = firstNonNull<any>(
    ctxPack?.mirror,
    extra?.mirror,
    (extra as any)?.ctxPack?.mirror,
    null,
  );

  const eTurn = pick(
    args?.e_turn,
    args?.eTurn,
    mirror?.e_turn,
    mirror?.eTurn,
    mirrorFlowV1ForSeed?.mirror?.e_turn,
    mirrorFlowV1ForSeed?.mirror?.eTurn,
    currentCardAny?.e_turn,
    qCountsForSeed?.e_turn_now,
    qCountsForSeed?.eTurnNow,
    qCountsForSeed?.e_turn,
    qCountsForSeed?.eTurn,
    ctxPack?.e_turn,
    ctxPack?.eTurn,
    extra?.e_turn,
    extra?.eTurn,
  );

  const exprMeta = (args?.exprMeta ?? ctxPack?.exprMeta ?? extra?.exprMeta ?? null) as any;
  const saRhythm = pick(exprMeta?.rhythm, args?.sa?.rhythm, ctxPack?.sa?.rhythm);
  const saTone = pick(exprMeta?.tone, args?.sa?.tone, ctxPack?.sa?.tone);
  const saBrevity = pick(exprMeta?.brevity, args?.sa?.brevity, ctxPack?.sa?.brevity);

  const polRaw = firstNonNull<any>(
    args?.polarity,
    mirror?.polarity,
    (mirror as any)?.polarity_out,
    (mirror as any)?.polarityBand,
    mirrorFlowV1ForSeed?.mirror?.polarity,
    mirrorFlowV1ForSeed?.mirror?.polarity_out,
    mirrorFlowV1ForSeed?.mirror?.polarityBand,
    currentCardAny?.polarity,
    ctxPack?.polarity,
    extra?.polarity,
    null,
  );
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
  const intentDir = pick(
    intent?.direction,
    args?.intentDirection,
    ctxPack?.intentDirection,
    extra?.intentDirection,
  );
  const itxStep = pick(
    args?.itx_step,
    ctxPack?.itx_step,
    extra?.itx_step,
    args?.itxStep,
    ctxPack?.itxStep,
  );
  const itxReason = pick(
    args?.itx_reason,
    ctxPack?.itx_reason,
    extra?.itx_reason,
    args?.itxReason,
    ctxPack?.itxReason,
  );

  const future = firstNonNull<any>(args?.future, ctxPack?.future, extra?.future, null);
  const futureHint = normFutureHint(
    firstNonNull<any>(future, args?.futureHint, ctxPack?.futureHint, null),
  );

  const flowHints = (
    args?.flows ??
    args?.cards ??
    ctxPack?.flows ??
    ctxPack?.cards ??
    extra?.flows ??
    extra?.cards ??
    null
  ) as any;

  const flowNow = normFlowText(
    firstNonNull<any>(
      flowHints?.now,
      flowHints?.flow_now,
      flowHints?.card_now,
      flowHints?.FLOW_NOW,
      flowHints?.CARD_NOW,
      args?.flowNow,
      args?.cardNow,
      ctxPack?.flowNow,
      ctxPack?.cardNow,
      null,
    ),
  );

  const flowNext = normFlowText(
    firstNonNull<any>(
      flowHints?.next,
      flowHints?.flow_next,
      flowHints?.card_next,
      flowHints?.FLOW_NEXT,
      flowHints?.CARD_NEXT,
      args?.flowNext,
      args?.cardNext,
      ctxPack?.flowNext,
      ctxPack?.cardNext,
      null,
    ),
  );

  const coordLines: string[] = [];
  if (qCode || depthStage || phase || eTurn || futureHint) {
    coordLines.push('COORD (DO NOT OUTPUT):');
    if (eTurn) coordLines.push(`e_turn=${eTurn}`);
    if (depthStage) coordLines.push(`depthStage=${depthStage}`);
    if (qCode) coordLines.push(`qCode=${qCode}`);
    if (phase) coordLines.push(`phase=${phase}`);

    const flowDelta = pick(flow?.delta, flow?.flowDelta);
    const returnStreak = pick(flow?.returnStreak, flow?.return_streak);
    const flowParts = [
      flowDelta && `delta=${flowDelta}`,
      returnStreak && `returnStreak=${returnStreak}`,
    ]
      .filter(Boolean)
      .join(' ');
    if (flowParts) coordLines.push(`flow=${flowParts}`);

    if (futureHint) coordLines.push(`future=${futureHint}`);
  }

  const inputKindNow = String(
    pick(
      args?.inputKind,
      ctxPack?.inputKind,
      (ctxPack as any)?.input_kind,
      (extra as any)?.inputKind,
      (extra as any)?.input_kind,
    ) ?? '',
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

  const flowDelta2 = String(pick(flow?.delta, (flow as any)?.flowDelta) ?? '').trim();
  const returnStreak2 = String(
    pick((flow as any)?.returnStreak, (flow as any)?.return_streak) ?? '',
  ).trim();

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
    confidenceRaw != null && String(confidenceRaw).trim() !== ''
      ? String(confidenceRaw).trim()
      : '';

  const seedLabel = seedTextRaw ? seedTextRaw.replace(/\s+/g, ' ').slice(0, 60) : '';

  const latestUserText = String(
    pick(
      (args as any)?.latestUserText,
      (args as any)?.userText,
      (args as any)?.text,
      (ctxPack as any)?.latestUserText,
      (ctxPack as any)?.userText,
      (extra as any)?.latestUserText,
      (extra as any)?.userText,
      '',
    ) ?? '',
  ).trim();

  const cleanMeaningLine = (v: any): string => {
    const s = String(v ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s === '(null)' || s === 'null' || s === 'undefined') return '';
    return s.slice(0, 120);
  };

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

  const stateCore = (
    meaningBits.length > 0 ? meaningBits.join(' / ') : '(no_state_core)'
  ).slice(0, 160);

  const flowCurrentRaw = String(
    pick(
      flowNow,
      (args as any)?.flowNow,
      (args as any)?.flow_now,
      (args as any)?.cardNow,
      (args as any)?.card_now,
      (ctxPack as any)?.flowNow,
      (ctxPack as any)?.flow_now,
      (ctxPack as any)?.cardNow,
      (ctxPack as any)?.card_now,
      (extra as any)?.flowNow,
      (extra as any)?.flow_now,
      (extra as any)?.cardNow,
      (extra as any)?.card_now,
      (ctxPack as any)?.flows?.current,
      (args as any)?.flows?.current,
      (extra as any)?.flows?.current,
      (ctxPack as any)?.cards?.current,
      (args as any)?.cards?.current,
      (extra as any)?.cards?.current,
      (ctxPack as any)?.flows?.now,
      (args as any)?.flows?.now,
      (extra as any)?.flows?.now,
      (ctxPack as any)?.cards?.now,
      (args as any)?.cards?.now,
      (extra as any)?.cards?.now,
      '',
    ) ?? '',
  );

  const flowNextRaw = String(
    pick(
      flowNext,
      (args as any)?.flowNext,
      (args as any)?.flow_next,
      (args as any)?.cardNext,
      (args as any)?.card_next,
      (ctxPack as any)?.flowNext,
      (ctxPack as any)?.flow_next,
      (ctxPack as any)?.cardNext,
      (ctxPack as any)?.card_next,
      (extra as any)?.flowNext,
      (extra as any)?.flow_next,
      (extra as any)?.cardNext,
      (extra as any)?.card_next,
      (ctxPack as any)?.flows?.next,
      (args as any)?.flows?.next,
      (extra as any)?.flows?.next,
      (ctxPack as any)?.cards?.next,
      (args as any)?.cards?.next,
      (extra as any)?.cards?.next,
      (ctxPack as any)?.flows?.future,
      (args as any)?.flows?.future,
      (extra as any)?.flows?.future,
      (ctxPack as any)?.cards?.future,
      (args as any)?.cards?.future,
      (extra as any)?.cards?.future,
      '',
    ) ?? '',
  );

  const flowCurrentMeaning = cleanMeaningLine(flowCurrentRaw) || '(none)';
  const flowNextMeaning = cleanMeaningLine(flowNextRaw) || '(none)';

  const flowBridge =
    flowCurrentMeaning !== '(none)' && flowNextMeaning !== '(none)'
      ? `${flowCurrentMeaning} → ${flowNextMeaning}`
      : flowDelta2 === 'RETURN'
        ? 'いったん戻って整理することで、次に進む基準ができる'
        : flowDelta2 === 'FORWARD'
          ? 'いまの動きが、そのまま次の展開を開きやすい'
          : flowCurrentMeaning !== '(none)'
            ? `いまの流れは「${flowCurrentMeaning}」にある`
            : flowNextMeaning !== '(none)'
              ? `この先は「${flowNextMeaning}」が開きやすい`
              : '(bridge_unknown)';

              const whyItMatchesBits: string[] = [];
              if (latestUserText) whyItMatchesBits.push(`user="${latestUserText.slice(0, 90)}"`);

              if (flowDelta2 === 'RETURN') {
                whyItMatchesBits.push('戻りの調整が入力の空気と合っている');
              } else if (flowDelta2 === 'FORWARD') {
                whyItMatchesBits.push('前に進みたい流れが入力の空気と合っている');
              }

              if (returnStreak2) whyItMatchesBits.push(`戻り回数=${returnStreak2}`);

              if (qCode === 'Q3') whyItMatchesBits.push('不安を整えたい基調がある');
              else if (qCode === 'Q2') whyItMatchesBits.push('引っかかりをほどいて進みたい基調がある');
              else if (qCode === 'Q1') whyItMatchesBits.push('秩序を保ちながら進めたい基調がある');
              else if (qCode === 'Q4') whyItMatchesBits.push('恐れを流して軽くしたい基調がある');
              else if (qCode === 'Q5') whyItMatchesBits.push('空白に火を戻したい基調がある');

              if (flowCurrentMeaning !== '(none)') whyItMatchesBits.push(`current=${flowCurrentMeaning}`);
              if (flowNextMeaning !== '(none)') whyItMatchesBits.push(`next=${flowNextMeaning}`);

              const whyItMatches = (
                whyItMatchesBits.length > 0 ? whyItMatchesBits.join(' / ') : '(match_unknown)'
              ).slice(0, 220);

              const shiftMeaning = (() => {
                if (flowCurrentMeaning !== '(none)' && flowNextMeaning !== '(none)') {
                  return `${flowCurrentMeaning} → ${flowNextMeaning}`;
                }
                if (flowCurrentMeaning !== '(none)') return flowCurrentMeaning;
                if (flowBridge !== '(bridge_unknown)') return flowBridge;
                return '(none)';
              })();

              const safeMeaning = (() => {
                if (qCode === 'Q3') return '今の安定を崩さずに整え直せば十分';
                if (qCode === 'Q2') return '引っかかりを一気に壊さず、ほどけるところから触れれば十分';
                if (qCode === 'Q1') return '秩序を崩さず、無理のない形で進めれば十分';
                if (qCode === 'Q4') return '怖さを無視せず、軽くできるところから進めれば十分';
                if (qCode === 'Q5') return '火を消さず、小さく戻すだけでも十分';
                if (flowBridge !== '(bridge_unknown)') return flowBridge;
                return '(none)';
              })();

              const relationFocusForSeed = (() => {
                const rf = (ctxPack as any)?.relationFocus ?? null;
                if (!rf || typeof rf !== 'object') return null;

                const selfPosition = String((rf as any)?.selfPosition ?? '').trim() || 'unknown';
                const otherPosition = String((rf as any)?.otherPosition ?? '').trim() || 'unknown';
                const powerBalance = String((rf as any)?.powerBalance ?? '').trim() || 'unknown';
                const distanceLevel = String((rf as any)?.distanceLevel ?? '').trim() || 'unknown';
                const certaintyLevel = String((rf as any)?.certaintyLevel ?? '').trim() || 'unknown';

                return {
                  selfPosition,
                  otherPosition,
                  powerBalance,
                  distanceLevel,
                  certaintyLevel,
                };
              })();

              const emotionalTemperatureForSeed = (() => {
                const raw = String((ctxPack as any)?.emotionalTemperature ?? '').trim().toLowerCase();
                if (raw === 'low' || raw === 'mid' || raw === 'high' || raw === 'volatile') return raw;
                return 'mid';
              })();

              const shiftKindForSeed = (() => {
                const raw = String((ctxPack as any)?.shiftKind ?? '').trim();
                if (raw) return raw;
                return inputKindNow === 'question' ? 'clarify_shift' : 'narrow_shift';
              })();

              const topicCorrectionGuard = (() => {
                const user = String((args as any)?.userText ?? '').trim();
                const sk = String(shiftKindForSeed ?? '').trim();

                const isTopicCorrection =
                  sk === 'clarify_shift' &&
                  user.length <= 24 &&
                  !/[?？]/.test(user) &&
                  (
                    /.+の話(です|だ)?よ?$/.test(user) ||
                    /.+のこと(です|だ)?よ?$/.test(user) ||
                    /.+について(です|だ)?よ?$/.test(user) ||
                    /話ですよ/.test(user)
                  );

                if (!isTopicCorrection) {
                  return {
                    active: false,
                    coreTopic: '',
                    guardLine: '(none)',
                    rules: [] as string[],
                  };
                }

                const coreTopic =
                  user
                    .replace(/(の話|のこと|について)(です|だ)?よ?$/g, '')
                    .trim() || user;

                const guardLine =
                  `いまは話題補正の入力。核は「${coreTopic}」。この語を上位カテゴリへ一般化しない。`;

                const rules = [
                  `Keep the exact topic nucleus as "${coreTopic}".`,
                  'Do not broaden to a parent topic.',
                  'Do not add examples unless the user asked for them.',
                  'Do not reinterpret into a nearby popular theme.',
                  'Confirm only within the same topic.',
                ];

                return {
                  active: true,
                  coreTopic,
                  guardLine,
                  rules,
                };
              })();

              const relationMeaning = (() => {
                const rf = relationFocusForSeed;
                if (!rf) return '(none)';

                const bits: string[] = [];

                if (rf.selfPosition === 'unclear') bits.push('自分の立ち位置がまだ定まっていない');
                else if (rf.selfPosition === 'approach') bits.push('自分は近づきたい側に寄っている');
                else if (rf.selfPosition === 'withdraw') bits.push('自分は少し離れて整えたい側に寄っている');

                if (rf.otherPosition === 'unreadable') bits.push('相手の位置が読めず、確信が持ちにくい');
                else if (rf.otherPosition === 'approaching') bits.push('相手側はやや近づいている可能性がある');
                else if (rf.otherPosition === 'distancing') bits.push('相手側は少し距離を取っている可能性がある');

                if (rf.powerBalance === 'weaker') bits.push('自分のほうが立場を弱く感じやすい');
                else if (rf.powerBalance === 'stronger') bits.push('自分が主導しやすい配置に寄っている');

                if (rf.distanceLevel === 'too_close') bits.push('近すぎて苦しさが出やすい');
                else if (rf.distanceLevel === 'far') bits.push('遠さが不安を強めやすい');
                else if (rf.distanceLevel === 'unstable') bits.push('距離の不安定さがしんどさを強めやすい');
                else if (rf.distanceLevel === 'close') bits.push('距離テーマが今の中心にある');

                if (rf.certaintyLevel === 'low') bits.push('確信不足が詰まりの中心にある');
                else if (rf.certaintyLevel === 'mid') bits.push('少しの見立てがあれば整理しやすい');

                return bits.length ? bits.join(' / ') : '(none)';
              })();

              const temperatureMeaning = (() => {
                if (emotionalTemperatureForSeed === 'low') return '静かに整えれば届く温度';
                if (emotionalTemperatureForSeed === 'mid') return '視点を1つ切ると動きやすい温度';
                if (emotionalTemperatureForSeed === 'high') return '先に受け止めてから角度を切るべき温度';
                if (emotionalTemperatureForSeed === 'volatile') return '今は切り分けすぎず、不安定さを増やさない方がよい状態';
                return '(none)';
              })();

              const bestShiftDirection = (() => {
                const rf = relationFocusForSeed;
                const sk = shiftKindForSeed;
                const temp = emotionalTemperatureForSeed;

                if (topicCorrectionGuard.active) {
                  return `「${topicCorrectionGuard.coreTopic}」のまま確認し、別の話題へ広げない`;
                }

                if (sk === 'clarify_shift') {
                  return '説明で閉じる。広げず、意味をそのまま返す';
                }

                if (temp === 'volatile') {
                  return 'まず論点を増やさず、不安定さを少し落ち着かせる方向を優先する';
                }

                if (temp === 'high') {
                  if (sk === 'distance_shift') return '距離を詰める/切る前に、先に自分の位置を戻す';
                  if (sk === 'decide_shift') return '決断を急がず、先に判断軸を1本に絞る';
                  return '先にいま起きていることを短く受け止め、そのあと1つだけ角度を切る';
                }

                if (rf) {
                  if (rf.distanceLevel === 'far') return '相手分析を増やすより、遠さで不安定になっている自分の基準を戻す';
                  if (rf.distanceLevel === 'too_close') return '近づくより先に、少し落ち着ける距離まで戻す';
                  if (rf.distanceLevel === 'unstable') return '関係全体を決めず、今ぶれている一点だけを狭く見る';
                  if (rf.certaintyLevel === 'low') return '答えを取りに行くより、何が読めないのかを1段狭める';
                  if (rf.powerBalance === 'weaker') return '相手基準で動く前に、自分の位置を先に定める';
                }

                if (sk === 'stabilize_shift') return '進めるより先に、戻って整える角度を優先する';
                if (sk === 'narrow_shift') return '問題を小さく切って、いま触る一点だけを見せる';
                if (sk === 'repair_shift') return '修復の正解探しではなく、安全な入口を1つだけ示す';
                if (sk === 'decide_shift') return '結論を急がず、選ぶ基準を先に固定する';
                if (sk === 'distance_shift') return '近づく/離れるの前に、いまの距離で何が苦しいかを定める';

                return '抽象化せず、いま動くための角度を1つだけ返す';
              })();

              const stingLevelForSeed = (() => {
                const pick = (v: any): 'LOW' | 'MID' | 'HIGH' | null => {
                  const s = String(v ?? '').trim().toUpperCase();
                  if (s === 'LOW' || s === 'MID' || s === 'HIGH') return s as 'LOW' | 'MID' | 'HIGH';
                  return null;
                };

                const fromCtx =
                  pick((ctxPack as any)?.stingLevel) ??
                  pick((ctxPack as any)?.state?.stingLevel) ??
                  null;

                if (fromCtx) return fromCtx;

                const d = String(depthStage || '').trim().toUpperCase().charAt(0);
                const rs =
                  typeof returnStreak2 === 'number'
                    ? returnStreak2
                    : Number.isFinite(Number(returnStreak2))
                      ? Number(returnStreak2)
                      : 0;

                let level: 'LOW' | 'MID' | 'HIGH' = 'LOW';
                if (d === 'C' || d === 'I' || d === 'T') level = 'HIGH';
                if (level !== 'HIGH' && rs >= 3) level = 'MID';
                if (level !== 'HIGH' && rs >= 5) level = 'HIGH';
                return level;
              })();

              const cueLabels = (() => {
                if (topicCorrectionGuard.active) {
                  return {
                    currentMeaning: '(none)',
                    shiftMeaning: topicCorrectionGuard.guardLine,
                    nextMeaning: '(none)',
                    flowBridge: '(suppressed_for_topic_correction)',
                    whyItMatches: `user="${topicCorrectionGuard.coreTopic}" / shiftKind=clarify_shift / topic_correction=true`,
                  };
                }

                if (shiftKindForSeed === 'clarify_shift') {
                  return {
                    currentMeaning: '(none)',
                    shiftMeaning: '質問の向きをそのまま受け取り、話題を広げずにこのテーマのどこを知りたいのかを狭く確かめる',
                    nextMeaning: '(none)',
                    flowBridge: '(suppressed_for_clarify)',
                    whyItMatches: `user="${String((ctxPack as any)?.situationSummary ?? '').trim() || '(none)'}" / shiftKind=clarify_shift`,
                  };
                }

                return {
                  currentMeaning: flowCurrentMeaning,
                  shiftMeaning,
                  nextMeaning: flowNextMeaning,
                  flowBridge,
                  whyItMatches,
                };
              })();

              const topicCorrectionResponseRules = topicCorrectionGuard.active
                ? [
                    `- Keep the topic fixed to "${topicCorrectionGuard.coreTopic}".`,
                    '- Do not widen the topic to parent categories.',
                    '- Do not introduce extra branches or examples unless the user asked for them.',
                    '- If you need to clarify, ask only what within that same topic the user wants to know.',
                  ]
                : [];

                const questionMeta = (() => {
                  const q =
                  (args as any)?.extra?.question ??
                  (args as any)?.userContext?.question ??
                  (args as any)?.userContext?.meta?.extra?.question ??
                    null;
                  return q && typeof q === 'object' ? q : null;
                })();

                const questionDomain = String((questionMeta as any)?.domain ?? '').trim();
                const questionType = String((questionMeta as any)?.questionType ?? '').trim();
                const questionTMode = String((questionMeta as any)?.tState?.mode ?? '').trim();
                const questionFocus = String((questionMeta as any)?.tState?.focus ?? '').trim();

                const questionPolicy = (() => {
                  const p = (questionMeta as any)?.outputPolicy;
                  if (!p || typeof p !== 'object') return '(none)';
                  try {
                    return JSON.stringify({
                      answerFirst: !!p.answerFirst,
                      askBackAllowed: !!p.askBackAllowed,
                      splitFactHypothesis: !!p.splitFactHypothesis,
                      usePastReframe: !!p.usePastReframe,
                      avoidPrematureClosure: !!p.avoidPrematureClosure,
                    });
                  } catch {
                    return '(none)';
                  }
                })();

                const recallDecision = (() => {
                  const extraAny =
                    ((args as any)?.extra && typeof (args as any).extra === 'object'
                      ? (args as any).extra
                      : {}) as any;

                  const userCtx =
                    ((args as any)?.userContext && typeof (args as any).userContext === 'object'
                      ? (args as any).userContext
                      : {}) as any;

                  const ctxPack =
                    (userCtx?.ctxPack && typeof userCtx.ctxPack === 'object'
                      ? userCtx.ctxPack
                      : extraAny?.ctxPack && typeof extraAny.ctxPack === 'object'
                        ? extraAny.ctxPack
                        : {}) as any;

                  const historyDigestV1Any =
                    (args as any)?.historyDigestV1 ??
                    userCtx?.historyDigestV1 ??
                    ctxPack?.historyDigestV1 ??
                    null;

                  const historyDigestTopic = String(
                    (historyDigestV1Any as any)?.topic?.situationTopic ??
                      (historyDigestV1Any as any)?.topic ??
                      '',
                  ).trim();

                  const historyDigestSummary = String(
                    (historyDigestV1Any as any)?.topic?.situationSummary ??
                      (historyDigestV1Any as any)?.summary ??
                      (historyDigestV1Any as any)?.shortSummary ??
                      '',
                  ).trim();

                  const historyForWriterSource =
                  (Array.isArray((args as any)?.userContext?.turnsForWriter) &&
                    (args as any).userContext.turnsForWriter.length > 0
                    ? (args as any).userContext.turnsForWriter
                    : Array.isArray((args as any)?.userContext?.ctxPack?.turnsForWriter) &&
                        (args as any).userContext.ctxPack.turnsForWriter.length > 0
                      ? (args as any).userContext.ctxPack.turnsForWriter
                      : Array.isArray((args as any)?.userContext?.turns) &&
                          (args as any).userContext.turns.length > 0
                        ? (args as any).userContext.turns
                        : []);

                const historyForWriterLen = Array.isArray(historyForWriterSource)
                  ? historyForWriterSource.length
                  : 0;

                    const longTermMemoryNoteText = String(
                      userCtx?.longTermMemoryNoteText ??
                        userCtx?.ctxPack?.longTermMemoryNoteText ??
                        extraAny?.longTermMemoryNoteText ??
                        extraAny?.ctxPack?.longTermMemoryNoteText ??
                        '',
                    ).trim();

                    console.log('[IROS/LTM][ROUTE_PATH_CHECK]', {
                      traceId:
                        (args as any)?.traceId ??
                        (args as any)?.extra?.traceId ??
                        extraAny?.traceId ??
                        null,
                      questionType,
                      questionDomain,

                      longTermMemoryNoteText:
                        typeof longTermMemoryNoteText === 'string'
                          ? longTermMemoryNoteText.slice(0, 200)
                          : null,

                      longTermMemoryNoteTextLen:
                        typeof longTermMemoryNoteText === 'string'
                          ? longTermMemoryNoteText.length
                          : 0,

                      memoryStateNoteText:
                        typeof userCtx?.memoryStateNoteText === 'string'
                          ? String(userCtx.memoryStateNoteText).slice(0, 200)
                          : typeof userCtx?.ctxPack?.memoryStateNoteText === 'string'
                            ? String(userCtx.ctxPack.memoryStateNoteText).slice(0, 200)
                            : typeof extraAny?.memoryStateNoteText === 'string'
                              ? String(extraAny.memoryStateNoteText).slice(0, 200)
                              : typeof extraAny?.ctxPack?.memoryStateNoteText === 'string'
                                ? String(extraAny.ctxPack.memoryStateNoteText).slice(0, 200)
                                : null,

                      memoryStateNoteTextLen:
                        typeof userCtx?.memoryStateNoteText === 'string'
                          ? String(userCtx.memoryStateNoteText).length
                          : typeof userCtx?.ctxPack?.memoryStateNoteText === 'string'
                            ? String(userCtx.ctxPack.memoryStateNoteText).length
                            : typeof extraAny?.memoryStateNoteText === 'string'
                              ? String(extraAny.memoryStateNoteText).length
                              : typeof extraAny?.ctxPack?.memoryStateNoteText === 'string'
                                ? String(extraAny.ctxPack.memoryStateNoteText).length
                                : 0,

                      ctxPackKeys:
                        userCtx?.ctxPack && typeof userCtx.ctxPack === 'object'
                          ? Object.keys(userCtx.ctxPack)
                          : [],

                      extraKeys:
                        extraAny && typeof extraAny === 'object'
                          ? Object.keys(extraAny)
                          : [],
                    });


                    const longTermMemoryTypes = (() => {
                      const xs: string[] = [];

                      if (/working_rule/i.test(longTermMemoryNoteText)) xs.push('working_rule');
                      if (/project_context/i.test(longTermMemoryNoteText)) xs.push('project_context');
                      if (/durable_fact/i.test(longTermMemoryNoteText)) xs.push('durable_fact');
                      if (/preference/i.test(longTermMemoryNoteText)) xs.push('preference');

                      // LTM Note が存在する場合は episodic_event 扱い
                      if (longTermMemoryNoteText && longTermMemoryNoteText.trim().length > 0) {
                        xs.push('episodic_event');
                      }

                      return xs;
                    })();

                    const hasEpisodicCandidate =
                    longTermMemoryTypes.includes('episodic_event') ||
                    /episodic_event/i.test(longTermMemoryNoteText);

                    const flowDeltaForRecall = String(
                      extraAny?.flowDelta ??
                        extraAny?.flow?.delta ??
                        extraAny?.flow?.flowDelta ??
                        extraAny?.ctxPack?.flowDelta ??
                        extraAny?.ctxPack?.flow?.delta ??
                        extraAny?.ctxPack?.flow?.flowDelta ??
                        ctxPack?.flowDelta ??
                        ctxPack?.flow?.delta ??
                        ctxPack?.flow?.flowDelta ??
                        (args as any)?.flowDelta ??
                        '',
                    ).trim();

                    const returnStreakForRecall = (() => {
                      const raw =
                        extraAny?.returnStreak ??
                        extraAny?.flow?.returnStreak ??
                        extraAny?.ctxPack?.returnStreak ??
                        extraAny?.ctxPack?.flow?.returnStreak ??
                        ctxPack?.returnStreak ??
                        ctxPack?.flow?.returnStreak ??
                        null;
                      return typeof raw === 'number'
                        ? raw
                        : Number.isFinite(Number(raw))
                          ? Number(raw)
                          : null;
                    })();
                  const stingLevelForRecall = String(
                    extraAny?.stingLevel ??
                      ctxPack?.stingLevel ??
                      stingLevelForSeed ??
                      '',
                  ).trim();

                  const userTextForRecall = String(
                    (args as any)?.userText ??
                      (args as any)?.text ??
                      userCtx?.userText ??
                      extraAny?.userText ??
                      '',
                  ).trim();

                  // ===== direct answer override =====
                  const userTextNorm = String(userTextForRecall || '').toLowerCase();
                  const directAnswerOverride =
                    /答え|結論|要するに|結局/.test(userTextNorm) &&
                    questionType === 'future_design';

                  const effectiveQuestionType = directAnswerOverride
                    ? 'direct_answer'
                    : questionType;

                  console.log('[IROS/writerCalls][RECALL_INPUT_DEBUG]', {
                    traceId:
                      (args as any)?.traceId ??
                      (args as any)?.extra?.traceId ??
                      extraAny?.traceId ??
                      null,
                      questionType: effectiveQuestionType,
                    questionDomain,
                    tLayerHint_candidates: {
                      userContext_tLayerHint: (args as any)?.userContext?.tLayerHint ?? null,
                      userContext_ctxPack_tLayerHint: (args as any)?.userContext?.ctxPack?.tLayerHint ?? null,
                      userContext_uiCue_tLayerHint: (args as any)?.userContext?.uiCue?.tLayerHint ?? null,
                      userContext_ctxPack_uiCue_tLayerHint:
                        (args as any)?.userContext?.ctxPack?.uiCue?.tLayerHint ?? null,
                      extra_tLayerHint: (args as any)?.extra?.tLayerHint ?? null,
                      extra_uiCue_tLayerHint: (args as any)?.extra?.uiCue?.tLayerHint ?? null,
                    },
                    itxStep_candidates: {
                      userContext_itxStep: (args as any)?.userContext?.itxStep ?? null,
                      userContext_ctxPack_itxStep: (args as any)?.userContext?.ctxPack?.itxStep ?? null,
                      userContext_uiCue_itxStep: (args as any)?.userContext?.uiCue?.itxStep ?? null,
                      userContext_ctxPack_uiCue_itxStep:
                        (args as any)?.userContext?.ctxPack?.uiCue?.itxStep ?? null,
                      extra_itxStep: (args as any)?.extra?.itxStep ?? null,
                      extra_uiCue_itxStep: (args as any)?.extra?.uiCue?.itxStep ?? null,
                    },
                    itTriggered_candidates: {
                      userContext_itTriggered: (args as any)?.userContext?.itTriggered ?? null,
                      userContext_it_triggered: (args as any)?.userContext?.it_triggered ?? null,
                      userContext_ctxPack_itTriggered: (args as any)?.userContext?.ctxPack?.itTriggered ?? null,
                      userContext_ctxPack_it_triggered:
                        (args as any)?.userContext?.ctxPack?.it_triggered ?? null,
                      userContext_ctxPack_qCounts_it_triggered_true:
                        (args as any)?.userContext?.ctxPack?.qCounts?.it_triggered_true ?? null,
                      userContext_ctxPack_qCounts_it_triggered:
                        (args as any)?.userContext?.ctxPack?.qCounts?.it_triggered ?? null,
                      userContext_uiCue_itTriggered: (args as any)?.userContext?.uiCue?.itTriggered ?? null,
                      userContext_ctxPack_uiCue_itTriggered:
                        (args as any)?.userContext?.ctxPack?.uiCue?.itTriggered ?? null,
                      extra_itTriggered: (args as any)?.extra?.itTriggered ?? null,
                      extra_it_triggered: (args as any)?.extra?.it_triggered ?? null,
                      extra_qCounts_it_triggered_true:
                        (args as any)?.extra?.qCounts?.it_triggered_true ?? null,
                      extra_qCounts_it_triggered: (args as any)?.extra?.qCounts?.it_triggered ?? null,
                      extra_uiCue_itTriggered: (args as any)?.extra?.uiCue?.itTriggered ?? null,
                      extra_blockPlan_itTriggered: (args as any)?.extra?.blockPlan?.itTriggered ?? null,
                    },
                    episodic_candidates: {
                      longTermMemoryNoteText,
                      longTermMemoryTypes,
                      hasEpisodicCandidate,
                    },
                    historyForWriterLen,
                  });
                  return decideRecallV1({
                    userText: userTextForRecall,
                    depthStage: depthStage || null,
                    qCode: qCode || null,
                    phase: phase || null,
                    intentAnchor: String(
                      extraAny?.intentAnchor ??
                        ctxPack?.intentAnchor ??
                        userCtx?.intentAnchor ??
                        '',
                    ).trim() || null,
                    selfAcceptance:
                      typeof extraAny?.selfAcceptance === 'number'
                        ? extraAny.selfAcceptance
                        : typeof ctxPack?.selfAcceptance === 'number'
                          ? ctxPack.selfAcceptance
                          : null,
                    flowDelta: flowDeltaForRecall || null,
                    returnStreak: returnStreakForRecall,
                    stingLevel: stingLevelForRecall || null,
                    flowDigest: String(
                      extraAny?.flowDigest ??
                        ctxPack?.flowDigest ??
                        '',
                    ).trim() || null,
                    questionType: effectiveQuestionType || null,
                    questionDomain: questionDomain || null,

                    tLayerHint:
                    String(
                      (args as any)?.userContext?.tLayerHint ??
                        (args as any)?.userContext?.ctxPack?.tLayerHint ??
                        (args as any)?.userContext?.uiCue?.tLayerHint ??
                        (args as any)?.userContext?.ctxPack?.uiCue?.tLayerHint ??
                        (args as any)?.extra?.tLayerHint ??
                        (args as any)?.extra?.uiCue?.tLayerHint ??
                        '',
                    ).trim() || null,
                  itxStep:
                    String(
                      (args as any)?.userContext?.itxStep ??
                        (args as any)?.userContext?.ctxPack?.itxStep ??
                        (args as any)?.userContext?.uiCue?.itxStep ??
                        (args as any)?.userContext?.ctxPack?.uiCue?.itxStep ??
                        (args as any)?.extra?.itxStep ??
                        (args as any)?.extra?.uiCue?.itxStep ??
                        '',
                    ).trim() || null,
                    itTriggered:
                    [
                      (args as any)?.userContext?.itTriggered,
                      (args as any)?.userContext?.it_triggered,
                      (args as any)?.userContext?.ctxPack?.itTriggered,
                      (args as any)?.userContext?.ctxPack?.it_triggered,
                      (args as any)?.userContext?.ctxPack?.qCounts?.it_triggered_true,
                      (args as any)?.userContext?.ctxPack?.qCounts?.it_triggered,
                      (args as any)?.userContext?.uiCue?.itTriggered,
                      (args as any)?.userContext?.ctxPack?.uiCue?.itTriggered,
                      (args as any)?.extra?.itTriggered,
                      (args as any)?.extra?.it_triggered,
                      (args as any)?.extra?.qCounts?.it_triggered_true,
                      (args as any)?.extra?.qCounts?.it_triggered,
                      (args as any)?.extra?.uiCue?.itTriggered,
                      (args as any)?.extra?.blockPlan?.itTriggered,
                    ].some((v) => v === true),
                    outputPolicy:
                      questionMeta && typeof (questionMeta as any)?.outputPolicy === 'object'
                        ? (questionMeta as any).outputPolicy
                        : null,
                    topicDigest:
                      String(
                        (args as any)?.topicDigest ??
                          userCtx?.topicDigest ??
                          ctxPack?.topicDigest ??
                          '',
                      ).trim() || null,
                    conversationLine:
                      String(
                        (args as any)?.conversationLine ??
                          userCtx?.conversationLine ??
                          ctxPack?.conversationLine ??
                          '',
                      ).trim() || null,
                    historyForWriterLen,
                    historyDigestTopic: historyDigestTopic || null,
                    historyDigestSummary: historyDigestSummary || null,
                    hasPastStateNoteText: Boolean(
                      extraAny?.pastStateNoteText ??
                        userCtx?.pastStateNoteText ??
                        userCtx?.meta?.extra?.pastStateNoteText,
                    ),
                    longTermMemoryTypes,
                    hasEpisodicCandidate,
                  });
                })();

                const memoryDecisionLines = [
                  'MEMORY_DECISION_V1:',
                  `RECALL_ELIGIBLE: ${recallDecision.recallEligible ? 'true' : 'false'}`,
                  `RECALL_SCOPE: ${recallDecision.recallScope}`,
                  `RECALL_REASON: ${recallDecision.recallReason || '(none)'}`,
                  `RECALL_MODE: ${recallDecision.recallMode}`,
                  `RECALL_SAFETY: ${recallDecision.recallSafety}`,
                  `SELECTED_SOURCES: ${
                    Array.isArray(recallDecision.selectedSources) &&
                    recallDecision.selectedSources.length > 0
                      ? recallDecision.selectedSources.join(', ')
                      : '(none)'
                  }`,
                  `EVIDENCE_SCORE: ${String(recallDecision.evidenceScore ?? 0)}`,
                  `DISALLOW_REASON: ${recallDecision.disallowReason || '(none)'}`,
                ];

                const flowMeaningV1 = buildFlowMeaningV1({
                  userText: String(
                    (args as any)?.userText ??
                      (args as any)?.text ??
                      (args as any)?.userContext?.userText ??
                      '',
                  ).trim(),
                  depthStage: depthStage || null,
                  qCode: qCode || null,
                  phase: phase || null,
                  observedStage: pick(
                    (ctxPack as any)?.observedStage,
                    (extra as any)?.observedStage,
                    currentCardAny?.observedStage,
                    null,
                  ),
                  primaryStage: pick(
                    (ctxPack as any)?.primaryStage,
                    (extra as any)?.primaryStage,
                    currentCardAny?.primaryStage,
                    currentCardAny?.observedStage,
                    null,
                  ),
                  secondaryStage: pick(
                    (ctxPack as any)?.secondaryStage,
                    (extra as any)?.secondaryStage,
                    currentCardAny?.secondaryStage,
                    null,
                  ),
                  flowDelta: String(
                    ((args as any)?.extra?.flowDelta ??
                      (args as any)?.userContext?.ctxPack?.flowDelta ??
                      (args as any)?.extra?.flow?.delta ??
                      (args as any)?.userContext?.ctxPack?.flow?.flowDelta ??
                      '') || '',
                  ).trim() || null,
                  returnStreak: (() => {
                    const raw =
                      (args as any)?.extra?.returnStreak ??
                      (args as any)?.userContext?.ctxPack?.returnStreak ??
                      (args as any)?.extra?.flow?.returnStreak ??
                      (args as any)?.userContext?.ctxPack?.flow?.returnStreak ??
                      null;
                    return typeof raw === 'number'
                      ? raw
                      : Number.isFinite(Number(raw))
                        ? Number(raw)
                        : null;
                  })(),
                  stingLevel: stingLevelForSeed || null,
                  flowDigest: String(
                    ((args as any)?.extra?.flowDigest ??
                      (args as any)?.userContext?.ctxPack?.flowDigest ??
                      '') || '',
                  ).trim() || null,
                  questionType: questionType || null,
                  questionDomain: questionDomain || null,
                  questionFocus: questionFocus || null,
                  questionTMode: questionTMode || null,
                  writerStyleKey: (() => {
                    const focus = String(questionFocus || '').trim();
                    const qType = String(questionType || '').trim();
                    const flow = String(flowDelta2 || '').trim();
                    const rs = Number.isFinite(Number(returnStreak2)) ? Number(returnStreak2) : 0;

                    if (qType !== 'choice') return null;
                    if (!/自分の意思と場の圧力|同調圧力|決定の急かし|空気圧/.test(focus)) return null;

                    if (rs >= 2) return 'choice_pressure_map';
                    if (flow === 'RETURN') return 'choice_pressure_insight';
                    if (flow === 'FORWARD') return 'choice_pressure_reclaim';

                    return 'choice_pressure_insight';
                  })(),
                  recallEligible: recallDecision.recallEligible,
                  recallScope: recallDecision.recallScope,
                  recallReason: recallDecision.recallReason,
                  topicDigest: String(
                    ((args as any)?.topicDigest ??
                      (args as any)?.userContext?.topicDigest ??
                      (args as any)?.userContext?.ctxPack?.topicDigest ??
                      '') || '',
                  ).trim() || null,
                  historyForWriterLen: (() => {
                    const uc: any = (args as any)?.userContext ?? {};
                    const cp: any = uc?.ctxPack ?? {};
                    const src =
                      Array.isArray(uc?.turnsForWriter) && uc.turnsForWriter.length > 0
                        ? uc.turnsForWriter
                        : Array.isArray(cp?.turnsForWriter) && cp.turnsForWriter.length > 0
                          ? cp.turnsForWriter
                          : Array.isArray(uc?.turns) && uc.turns.length > 0
                            ? uc.turns
                            : [];
                    return Array.isArray(src) ? src.length : 0;
                  })(),
                });

                const questionIframeKeys = (() => {
                  const hs = Array.isArray((questionMeta as any)?.iframe?.hypothesisSpace)
                    ? (questionMeta as any).iframe.hypothesisSpace
                    : [];
                  const keys = hs
                    .map((x: any) => String(x?.key ?? '').trim())
                    .filter(Boolean)
                    .slice(0, 8);
                  return keys.length > 0 ? keys.join(', ') : '(none)';
                })();
                const compactMemoryLine = [
                  `eligible=${recallDecision.recallEligible ? 'true' : 'false'}`,
                  `scope=${recallDecision.recallScope}`,
                  `reason=${recallDecision.recallReason || '(none)'}`,
                ].join(' / ');

                const compactQuestionLine = [
                  `domain=${questionDomain || '(none)'}`,
                  `type=${questionType || '(none)'}`,
                  `mode=${questionTMode || '(none)'}`,
                  `focus=${questionFocus || '(none)'}`,
                ].join(' / ');

                const compactMetaLine = [
                  `depth=${depthStage || '(none)'}`,
                  `phase=${phase || '(none)'}`,
                  `q=${qCode || '(none)'}`,
                  `sting=${stingLevelForSeed || '(none)'}`,
                  `shift=${shiftKindForSeed || '(none)'}`,
                  `temp=${emotionalTemperatureForSeed || '(none)'}`,
                  `flow=${flowDelta2 || '(none)'}:${returnStreak2 || '0'}`,
                  `e_turn=${eTurn2 || '(none)'}`,
                ].join(' / ');

                const writerStyleKey = (() => {
                  const focus = String(questionFocus || '').trim();
                  const openLoop = String(flowMeaningV1?.openLoop ?? '').trim();
                  const qType = String(questionType || '').trim();
                  const flow = String(flowDelta2 || '').trim();

                  if (
                    qType === 'choice' &&
                    (
                      /自分の意思と場の圧力|同調圧力|決定の急かし|空気圧/.test(focus) ||
                      /自分の意思と場の圧力|YESのあとに残るズレ|NOを言えなくなる圧/.test(openLoop)
                    )
                  ) {
                    return 'choice_self_vs_pressure';
                  }

                  if (qType === 'structure') {
                    return 'structure_explain';
                  }

                  if (flow === 'RETURN') {
                    return 'return_adjust';
                  }

                  return 'default';
                })();

                const writerStyleRuleLines = (() => {
                  switch (writerStyleKey) {
                    case 'choice_self_vs_pressure':
                      return [
                        '- Start from the loss of agency or loss of pause, not from abstract general advice.',
                        '- Name the user’s displaced hesitation before giving any suggestion.',
                        '- Prefer continuous empathic prose over bullet points unless the user explicitly asked for a list.',
                        '- Do not widen to social theory or generic self-help.',
                        '- End with only one narrow question, choosing either pressure-source or lost-pause.',
                      ];

                      case 'structure_explain':
                        return [
                          '- Explain the structure plainly and compactly.',
                          '- Prioritize frame and mechanism over emotional expansion.',
                          '- Avoid poetic drift and avoid widening beyond the asked structure.',
                          '- Do not end with a question.',
                          '- Do not ask the user to introspect or continue unless explicitly requested.',
                          '- Finish with the explanation itself.',
                        ];

                      case 'return_adjust':
                        return [
                          '- Treat this as a return/adjustment turn.',
                          '- Do not force progress; help the user recover the missing point.',
                          '- Keep the response soft, narrow, and low-pressure.',
                        ];

                      default:
                        return [
                          '- Keep it narrow and grounded.',
                          '- Answer the user’s meaning before expanding.',
                          '- Avoid generic broadening.',
                          '- Do not add a closing question when questions_max is 0.',
                        ];
                  }
                })();

                const coreAssertionLine = (() => {
                  const hook0 = String(flowMeaningV1?.thisTurnHook ?? '').trim();
                  const tension0 = String(flowMeaningV1?.continuingTension ?? '').trim();
                  const shift0 = String(cueLabels?.shiftMeaning ?? '').trim();
                  const core0 = String(stateCore ?? '').trim();

                  const candidates = [
                    hook0,
                    tension0,
                    shift0,
                    core0,
                  ].filter((v) => v.length > 0);

                  const picked =
                    candidates.find((v) => v.length >= 12) ??
                    candidates[0] ??
                    '';

                  return picked.replace(/\s+/g, ' ').trim();
                })();

                const mirrorFlowSeedBuilt = buildMirrorFlowSeed({
                  observedStage: pick(
                    (ctxPack as any)?.observedStage,
                    (extra as any)?.observedStage,
                    currentCardAny?.observedStage,
                    null,
                  ),
                  primaryStage: pick(
                    (ctxPack as any)?.primaryStage,
                    (extra as any)?.primaryStage,
                    currentCardAny?.primaryStage,
                    currentCardAny?.observedStage,
                    null,
                  ),
                  secondaryStage: pick(
                    (ctxPack as any)?.secondaryStage,
                    (extra as any)?.secondaryStage,
                    currentCardAny?.secondaryStage,
                    null,
                  ),

                  depthStage: depthStage ?? null,
                  depthHistoryLite: Array.isArray((ctxPack as any)?.depthHistoryLite)
                    ? (ctxPack as any).depthHistoryLite
                    : Array.isArray((extra as any)?.depthHistoryLite)
                      ? (extra as any).depthHistoryLite
                      : null,

                  e_turn: eTurn || eTurn2 || null,
                  polarity: polarity ?? null,
                  basedOn:
                    latestUserText ||
                    String((ctxPack as any)?.conversationLine ?? '').trim() ||
                    String((ctxPack as any)?.topicDigest ?? '').trim() ||
                    null,

                  willRotation:
                    (ctxPack as any)?.willRotation ??
                    (extra as any)?.willRotation ??
                    null,

                    tLayerHint: pick(
                      (ctxPack as any)?.tLayerHint,
                      (extra as any)?.tLayerHint,
                      null,
                    ),
                    itOk: (() => {
                      if (typeof (ctxPack as any)?.itOk === 'boolean') return (ctxPack as any).itOk;
                      if (typeof (ctxPack as any)?.itTriggered === 'boolean') return (ctxPack as any).itTriggered;
                      if (typeof (ctxPack as any)?.it_triggered === 'boolean') return (ctxPack as any).it_triggered;

                      if (typeof (extra as any)?.itOk === 'boolean') return (extra as any).itOk;
                      if (typeof (extra as any)?.itTriggered === 'boolean') return (extra as any).itTriggered;
                      if (typeof (extra as any)?.it_triggered === 'boolean') return (extra as any).it_triggered;

                      const itxReasonNorm = String(itxReason ?? '').trim().toUpperCase();
                      if (itxReasonNorm.includes('IT_TRIGGER_OK') || itxReasonNorm.includes('IT_HOLD')) {
                        return true;
                      }

                      const itxStepNorm = String(itxStep ?? '').trim().toUpperCase();
                      if (/^T[123]$/.test(itxStepNorm)) return true;

                      return null;
                    })(),

                  qCode: qCode ?? null,
                  flowDelta: flowDelta2 || null,

                  writerDirectives: {
                    tone: 'reflective',
                    maxLines: 6,
                    slotPolicy:
                      flowDelta2 === 'RETURN' &&
                      String((ctxPack as any)?.willRotation?.descentGate ?? (extra as any)?.willRotation?.descentGate ?? '').trim().toLowerCase() === 'closed' &&
                      /^R[1-3]$/i.test(String(depthStage ?? '').trim())
                        ? 'CONTINUITY_FIRST'
                        : 'OBS_FIRST',
                    rotationMention: '1sentence',
                  },
                });

                const mirrorFlowSeedFormatted = formatMirrorFlowSeed(mirrorFlowSeedBuilt);
                const mirrorFlowSeedText = String(mirrorFlowSeedFormatted.mirrorFlowSeedText ?? '').trim();

                const cardsSeedText = String(
                  pick(
                    (ctxPack as any)?.cards?.seedText,
                    (extra as any)?.ctxPack?.cards?.seedText,
                    (extra as any)?.cards?.seedText,
                    '',
                  ) ?? '',
                ).trim();

                const coordMinimal: string[] = [];
                coordMinimal.push('COORD (DO NOT OUTPUT):');
                if (eTurn) coordMinimal.push(`e_turn=${eTurn}`);
                if (depthStage) coordMinimal.push(`depthStage=${depthStage}`);
                if (qCode) coordMinimal.push(`qCode=${qCode}`);
                if (phase) coordMinimal.push(`phase=${phase}`);
                if (polarity) coordMinimal.push(`polarity=${polarity}`);

                const coordMinimalBlock = coordMinimal.length > 1 ? coordMinimal.join('\n') : '';

                const internalPackRawLight = String(internalPackRaw ?? '')
                  .replace(
                    /\n*CARD_PACKET\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\nSTATE_CUES_V3\s*\(DO NOT OUTPUT\):|\nINTERNAL PACK\s*\(DO NOT OUTPUT\):|$)/g,
                    '\n',
                  )
                  .replace(
                    /\n*STATE_CUES_V3\s*\(DO NOT OUTPUT\):[\s\S]*?(?=\nINTERNAL PACK\s*\(DO NOT OUTPUT\):|$)/g,
                    '\n',
                  )
                  .replace(/\n{3,}/g, '\n\n')
                  .trim();

                  const seedBlocksForWriter = [mirrorFlowSeedText].filter((x) => norm(x));
                  const seedBlockForWriter = seedBlocksForWriter.join('\n\n');

                  const injectedHead = [coordMinimalBlock, seedBlockForWriter]
                    .filter((x) => norm(x))
                    .join('\n\n');

                const internalPackFixed = injectedHead.trim();
                  try {
                    const packNorm = norm(internalPackFixed);
                    const h = packNorm.slice(0, 900);

                    const flowMatch = packNorm.match(/FLOW_CONTEXT(?:\s*\(DO NOT OUTPUT\))?:|FLOW_MEANING(?:\s*\(DO NOT OUTPUT\))?:/);
                    const flowIdx = flowMatch ? flowMatch.index ?? -1 : -1;
                    const flowSnippet =
                      flowIdx >= 0 ? packNorm.slice(flowIdx, Math.min(packNorm.length, flowIdx + 520)) : '';

                    const hasOpenness =
                      /(?:^|\n)OPENNESS(?:\n|$)/.test(packNorm) ||
                      /tLayerHint=|itOk=/.test(packNorm);

                    const hasWriterDirectives =
                      /(?:^|\n)WRITER_DIRECTIVES(?:\n|$)/.test(packNorm) ||
                      /tone=|maxLines=|slotPolicy=|rotationMention=/.test(packNorm);

                    console.log('[IROS/writerCalls][INJECTED_PACK_HEAD]', {
                      traceId: (args as any)?.traceId ?? null,
                      conversationId: (args as any)?.conversationId ?? null,
                      packLen: packNorm.length,
                      head: h,
                      hasCOORD: /COORD\s*\(DO NOT OUTPUT\)/.test(packNorm),
                      hasPolarity: /polarity=/.test(packNorm),
                      hasSA: /sa=/.test(packNorm),

                      // 旧 itx_step / itx_reason だけでなく、MirrorFlow Seed v1 の OPENNESS も検知する
                      hasITX:
                        /itx_step=|itx_reason=/.test(packNorm) ||
                        /tLayerHint=|itOk=/.test(packNorm),

                      hasFuture: /future=/.test(packNorm),
                      hasStateCues: /STATE_CUES_V3\s*\(DO NOT OUTPUT\)/.test(packNorm),
                      hasFlowMeaning: flowIdx >= 0,

                      hasMirrorFlowSeed: /MIRROR_FLOW_SEED_V1\b/.test(packNorm),
                      hasOpenness,
                      hasWriterDirectives,

                      flowSnippet,
                      saRhythm: saRhythm || null,
                      saTone: saTone || null,
                      saBrevity: saBrevity || null,
                      itxStep: itxStep || null,
                      itxReason: itxReason || null,
                    });
                  } catch {}

  const shiftMeta = (() => {
    const s = String(internalPackFixed ?? '');

    const mShift = s.match(/@SHIFT\s+(\{[\s\S]*?\})(?:\n|$)/);
    if (mShift?.[1]) {
      try {
        const j = JSON.parse(mShift[1]);
        return {
          hint: String(j?.hint ?? '').trim(),
          kind: String(j?.kind ?? '').trim(),
          meaningKind: String(j?.meaning_kind ?? '').trim(),
          intent: String(j?.intent ?? '').trim(),
        };
      } catch {}
    }


    return {
      hint: '',
      kind: '',
      meaningKind: '',
      intent: '',
    };
  })();

  const shiftHintRaw = shiftMeta.hint;
  const shiftKindRaw = shiftMeta.kind;
  const meaningKindRaw = shiftMeta.meaningKind;
  const shiftIntentRaw = shiftMeta.intent;

  const internalPackForWriter = String(internalPackFixed ?? '')
    .replace(/^[ \t]*@OBS[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@SHIFT[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@SAFE[^\n]*(?:\n|$)/gm, '')
    .replace(/^[ \t]*@NEXT_HINT[^\n]*(?:\n|$)/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const isTopicRecallTurn =
    meaningKindRaw === 'topic_recall';

  const isStructureTurn =
    meaningKindRaw === 'structure';

  const isClarifyMeaningTurn =
    !isTopicRecallTurn &&
    !isStructureTurn &&
    (
      shiftHintRaw === 'clarify_meaning_v1' ||
      (shiftKindRaw === 'clarify' && meaningKindRaw === 'define')
    );

    const turnsRaw = turnsToMessages(args.turns, { maxTurnLen: 900, maxUserTurnLen: 900 });

    const currentUserTextNorm = stripInternalMarkersFromUserText(String(args.userText ?? ''))
      .replace(/\r\n/g, '\n')
      .trim();

    const turnsBase = Array.isArray(turnsRaw) ? turnsRaw : [];

    const turnsDeduped = (() => {
      if (!currentUserTextNorm) return turnsBase;

      return turnsBase.filter((m, idx) => {
        if (m?.role !== 'user') return true;

        const contentNorm = stripInternalMarkersFromUserText(String(m?.content ?? ''))
          .replace(/\r\n/g, '\n')
          .trim();

        if (!contentNorm) return false;

        const isSameAsCurrentUser = contentNorm === currentUserTextNorm;
        if (!isSameAsCurrentUser) return true;

        try {
          console.log('[IROS/writerCalls][DROP_DUP_CURRENT_USER_IN_TURNS]', {
            idx,
            len: contentNorm.length,
            head: contentNorm.slice(0, 80),
          });
        } catch {}

        return false;
      });
    })();

    // clarify_meaning_v1 / topic_recall では古い履歴汚染を避ける
    // - 直前1往復だけ残す
    // - ただし current turn は ensureEndsWithUser(args.userText) が後で正本を付ける
    const turns =
      (isClarifyMeaningTurn || isTopicRecallTurn)
        ? (() => {
            const tail = turnsDeduped.slice(-2);
            // 末尾 user は current turn 混入のことがあるので落とす
            if (tail.length > 0 && tail[tail.length - 1]?.role === 'user') {
              return tail.slice(0, -1);
            }
            return tail;
          })()
        : turnsDeduped;

      const packMsg: WriterMessage | null = internalPackForWriter
      ? { role: 'assistant', content: internalPackForWriter }
      : null;

      const topicRecallNoEvidenceMsg: WriterMessage | null =
      isTopicRecallTurn && (!Array.isArray(turns) || turns.length === 0)
        ? {
            role: 'assistant',
            content: [
              'TOPIC_RECALL_NO_EVIDENCE (DO NOT OUTPUT):',
              '- This turn is topic_recall, but there is no usable prior turn evidence.',
              '- Do NOT say the topic is "this interaction itself", "whether I understand", "alignment", or "meta confirmation".',
              '- Do NOT ask for the previous line, a keyword, or extra clarification as the main answer.',
              '- Output plainly: 「この一文だけでは、直前までの話題はまだ特定できない。」',
              '- After that, you may add at most one short neutral bridge sentence.',
            ].join('\n'),
          }
        : null;

    let messages: WriterMessage[] = [
      { role: 'system', content: systemOne },
      ...(packMsg ? [packMsg] : []),
      ...(topicRecallNoEvidenceMsg ? [topicRecallNoEvidenceMsg] : []),
      ...turns,
    ];

  messages = mergeConsecutiveSameRole(messages);
  messages = ensureEndsWithUser(messages, String(args.userText ?? ''));

  let digest = (args.historyDigestV1 ?? null) as HistoryDigestV1 | null;
  if (digest) {
    const injected = injectHistoryDigestV1({ messages, digest }) as any;

    const injectedMsgs = (injected?.messages ?? null) as WriterMessage[] | null;
    if (Array.isArray(injectedMsgs) && injectedMsgs.length > 0) {
      messages = injectedMsgs;
    }

    const injectedDigest = (injected?.digest ?? null) as HistoryDigestV1 | null;
    if (injectedDigest) {
      digest = injectedDigest;
    }
  }

  messages = foldLeadingSystemToOne(messages);
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
        if (!s1) return null;
        return { role: 'user', content: s1 } as WriterMessage;
      }

      const a0 = norm(String(t?.content ?? t?.text ?? ''));
      const a1 = clampStr(a0, 900);
      return a1 ? ({ role: 'assistant', content: a1 } as WriterMessage) : null;
    })
    .filter(Boolean) as WriterMessage[];

    const userTextSanitized = clampStr(
      stripInternalMarkersFromUserText(String(args.userText ?? '')),
      900,
    );

    const retryUserContent =
      baseDraft && baseDraft !== '(empty)' && baseDraft !== '（入力なし）'
        ? baseDraft
        : userTextSanitized;
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
      { role: 'user', content: retryUserContent },
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
  extra?: any;
  userContext?: any;
  audit?: any;

  // ✅ 追加：HistoryDigest v1（存在する時だけ注入）
  historyDigestV1?: HistoryDigestV1 | null;

  // ✅ 追加：オウム返し除去ガード専用（比較に使う）
  echoGuardUserText?: string | null;

  // ✅ 互換で残す（この関数内では参照しない）
  allowRawUserText?: boolean | null;
}): Promise<string> {

  // ✅ topic_recall / no evidence は LLM に行かず固定返答で止める
  try {
    const hasTopicRecallNoEvidence = Array.isArray(args.messages)
      && args.messages.some(
        (m) =>
          m?.role === 'assistant'
          && /TOPIC_RECALL_NO_EVIDENCE \(DO NOT OUTPUT\):/.test(String(m?.content ?? '')),
      );

    if (hasTopicRecallNoEvidence) {
      return 'この一文だけでは、直前までの話題はまだ特定できない。';
    }
  } catch {}
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
        if (!s1) return null;
        return { role: 'user', content: s1 } as WriterMessage;
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
    max_tokens: 1200,
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
