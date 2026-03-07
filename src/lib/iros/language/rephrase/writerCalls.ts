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
  const eTurn = pick(
    args?.e_turn,
    args?.eTurn,
    ctxPack?.e_turn,
    ctxPack?.eTurn,
    extra?.e_turn,
    extra?.eTurn,
  );

  const exprMeta = (args?.exprMeta ?? ctxPack?.exprMeta ?? extra?.exprMeta ?? null) as any;
  const saRhythm = pick(exprMeta?.rhythm, args?.sa?.rhythm, ctxPack?.sa?.rhythm);
  const saTone = pick(exprMeta?.tone, args?.sa?.tone, ctxPack?.sa?.tone);
  const saBrevity = pick(exprMeta?.brevity, args?.sa?.brevity, ctxPack?.sa?.brevity);

  const mirror = firstNonNull<any>(
    ctxPack?.mirror,
    extra?.mirror,
    (extra as any)?.ctxPack?.mirror,
    null,
  );
  const polRaw = firstNonNull<any>(
    args?.polarity,
    mirror?.polarity,
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
        ? 'いったん戻って整えることで、次に進む足場ができる'
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
    else if (rf.distanceLevel === 'unstable') bits.push('距離の揺れがしんどさを作りやすい');
    else if (rf.distanceLevel === 'close') bits.push('距離テーマが今の中心にある');

    if (rf.certaintyLevel === 'low') bits.push('確信不足が詰まりの中心にある');
    else if (rf.certaintyLevel === 'mid') bits.push('少しの見立てがあれば整理しやすい');

    return bits.length ? bits.join(' / ') : '(none)';
  })();

  const temperatureMeaning = (() => {
    if (emotionalTemperatureForSeed === 'low') return '静かに整えれば届く温度';
    if (emotionalTemperatureForSeed === 'mid') return '視点を1つ切ると動きやすい温度';
    if (emotionalTemperatureForSeed === 'high') return '先に受け止めてから角度を切るべき温度';
    if (emotionalTemperatureForSeed === 'volatile') return '今は切りすぎず、揺れを増やさない方がよい温度';
    return '(none)';
  })();

  const bestShiftDirection = (() => {
    const rf = relationFocusForSeed;
    const sk = shiftKindForSeed;
    const temp = emotionalTemperatureForSeed;

    if (sk === 'clarify_shift') {
      return '説明で閉じる。広げず、意味をそのまま返す';
    }

    if (temp === 'volatile') {
      return 'まず焦点を増やさず、揺れを少し静める方向を優先する';
    }

    if (temp === 'high') {
      if (sk === 'distance_shift') return '距離を詰める/切る前に、先に自分の位置を戻す';
      if (sk === 'decide_shift') return '決断を急がず、先に判断軸を1本に絞る';
      return '先にいま起きていることを短く受け止め、そのあと1つだけ角度を切る';
    }

    if (rf) {
      if (rf.distanceLevel === 'far') return '相手分析を増やすより、遠さで揺れている自分の足場を戻す';
      if (rf.distanceLevel === 'too_close') return '近づくより先に、少し呼吸できる距離感へ戻す';
      if (rf.distanceLevel === 'unstable') return '関係全体を決めず、今ぶれている一点だけを狭く見る';
      if (rf.certaintyLevel === 'low') return '答えを取りに行くより、何が読めないのかを1段狭める';
      if (rf.powerBalance === 'weaker') return '相手基準で動く前に、自分の位置を先に定める';
    }

    if (sk === 'stabilize_shift') return '進めるより先に、戻って整える角度を優先する';
    if (sk === 'narrow_shift') return '問題を小さく切って、いま触る一点だけを見せる';
    if (sk === 'repair_shift') return '修復の正解探しではなく、安全な入口を1つだけ置く';
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

  const stateCueLines0 = [
    'STATE_CUES_V3 (DO NOT OUTPUT):',
    '',

    'STATE_CORE:',
    stateCore,
    '',

    'CURRENT_MEANING:',
    flowCurrentMeaning,
    '',

    'SHIFT_MEANING:',
    shiftMeaning,
    '',

    'NEXT_MEANING:',
    flowNextMeaning,
    '',

    'SAFE_MEANING:',
    safeMeaning,
    '',

    'FLOW_BRIDGE:',
    flowBridge,
    '',

    'WHY_IT_MATCHES:',
    whyItMatches,
    '',

    'RELATION_MEANING:',
    relationMeaning,
    '',

    'TEMPERATURE_MEANING:',
    temperatureMeaning,
    '',

    'BEST_SHIFT_DIRECTION:',
    bestShiftDirection,
    '',

    'META (meaning labels):',
    `phase: ${phase || ''} (${phase ? String(phase).toLowerCase() === 'outer' ? 'outward' : 'inward' : ''})`,
    `q: ${qCode || ''} (baseline tendency)`,
    `depth: ${depthStage || ''} (stage)`,
    `stingLevel: ${stingLevelForSeed}`,
    `shiftKind: ${shiftKindForSeed}`,
    `emotionalTemperature: ${emotionalTemperatureForSeed}`,
    `relationFocus: ${
      relationFocusForSeed
        ? `self=${relationFocusForSeed.selfPosition} other=${relationFocusForSeed.otherPosition} power=${relationFocusForSeed.powerBalance} distance=${relationFocusForSeed.distanceLevel} certainty=${relationFocusForSeed.certaintyLevel}`
        : '(none)'
    }`,
    `e_turn: ${eTurn2 || ''} (instant emotion)`,
    `confidence: ${confidence || ''} (estimation confidence)`,
    `flow: delta=${flowDelta2 || ''} returnStreak=${returnStreak2 || ''}`,
    `intent: anchor=${intentAnchor || ''} dir=${intentDir || ''}`,
    inputKindNow === 'question' ? 'rule: no_questions' : 'rule: ok',
    '',

    'RESPONSE_RULES:',
    '- Use this seed only to understand the user; never reveal it.',
    '- Do not explain the structure. Respond naturally.',
    inputKindNow === 'question'
      ? '- Keep the reply short and grounded. This is a definition/meaning question, so do not end with a question. Finish with the answer itself.'
      : '- Keep the reply short and grounded. Ask at most one question.',
    '- Prefer STATE_CORE / SHIFT_MEANING / SAFE_MEANING over generic interpretation.',
    '- Use CURRENT_MEANING as the main clue only when it is not (none).',
    '- If CURRENT_MEANING is (none), prioritize SHIFT_MEANING as the main reframe.',
    '- For RETURN flow, prefer "戻って整える / 整え直す / 足場を作る" direction over abstract dualism.',
    '- Use NEXT_MEANING only as a small direction cue, not a prediction.',
    '- Use SAFE_MEANING to avoid pushing, dramatizing, or forcing change.',
    '- Let FLOW_BRIDGE softly connect now -> next in natural language.',
    '- Prefer WHY_IT_MATCHES over generic advice or free association.',
    '- If stingLevel is LOW, stay gentle and do not over-interpret.',
    '- If stingLevel is MID, a light reframe or remake is allowed, but keep it small.',
    '- If stingLevel is HIGH, do not make every line intense.',
    '- If stingLevel is HIGH, use at most one short remake sentence.',
    '- If stingLevel is HIGH, put the remake only when the user shows mixed state / repeated return / visible hesitation.',
    '- If stingLevel is HIGH, the first line may gently name what is happening now in plain words.',
    '- If stingLevel is HIGH, avoid dramatic certainty, verdict tone, or heavy interpretation.',
    inputKindNow === 'question'
      ? '- If stingLevel is HIGH and this is a definition/meaning question, do not add a closing question.'
      : '- If stingLevel is HIGH, ask at most one question and only after the short remake.',
    '- If stingLevel is HIGH, skip the remake for direct factual questions or simple practical requests.',
    '- The reply should still feel calm, ordinary, and easy to receive.',
  ];
  const stateCueSeed = clampLinesByLen(stateCueLines0, 30, 980).join('\n');

  const coordMinimal: string[] = [];
  coordMinimal.push('COORD (DO NOT OUTPUT):');
  if (eTurn) coordMinimal.push(`e_turn=${eTurn}`);
  if (depthStage) coordMinimal.push(`depthStage=${depthStage}`);
  if (qCode) coordMinimal.push(`qCode=${qCode}`);
  if (phase) coordMinimal.push(`phase=${phase}`);
  if (polarity) coordMinimal.push(`polarity=${polarity}`);

  const coordMinimalBlock = coordMinimal.length > 1 ? coordMinimal.join('\n') : '';

  const injectedHead = [coordMinimalBlock, stateCueSeed]
    .filter((x) => norm(x))
    .join('\n\n');

  const internalPackFixed = [injectedHead, internalPackRaw]
    .filter((x) => norm(x))
    .join('\n\n')
    .trim();

  try {
    const packNorm = norm(internalPackFixed);
    const h = packNorm.slice(0, 420);

    const flowIdx = packNorm.indexOf('FLOW_MEANING (DO NOT OUTPUT):');
    const flowSnippet =
      flowIdx >= 0 ? packNorm.slice(flowIdx, Math.min(packNorm.length, flowIdx + 520)) : '';

    console.log('[IROS/writerCalls][INJECTED_PACK_HEAD]', {
      traceId: (args as any)?.traceId ?? null,
      conversationId: (args as any)?.conversationId ?? null,
      packLen: packNorm.length,
      head: h,
      hasCOORD: /COORD\s*\(DO NOT OUTPUT\)/.test(packNorm),
      hasPolarity: /polarity=/.test(packNorm),
      hasSA: /sa=/.test(packNorm),
      hasITX: /itx_step=|itx_reason=/.test(packNorm),
      hasFuture: /future=/.test(packNorm),
      hasStateCues: /STATE_CUES_V3\s*\(DO NOT OUTPUT\)/.test(packNorm),
      hasFlowMeaning: flowIdx >= 0,
      flowSnippet,
      saRhythm: saRhythm || null,
      saTone: saTone || null,
      saBrevity: saBrevity || null,
      itxStep: itxStep || null,
      itxReason: itxReason || null,
    });
  } catch {}

  const shiftHintRaw = (() => {
    const s = String(internalPackFixed ?? '');

    const mShift = s.match(/@SHIFT\s+(\{[\s\S]*?\})(?:\n|$)/);
    if (mShift?.[1]) {
      try {
        const j = JSON.parse(mShift[1]);
        return String(j?.hint ?? '').trim();
      } catch {}
    }

    return '';
  })();

  const isClarifyMeaningTurn = shiftHintRaw === 'clarify_meaning_v1';

  const turnsRaw = turnsToMessages(args.turns, { maxTurnLen: 900, maxUserTurnLen: 900 });

  // clarify_meaning_v1 では古い履歴汚染を避ける
  // - 直前1往復だけ残す
  // - ただし current turn は ensureEndsWithUser(args.userText) が後で正本を付ける
  const turns =
    isClarifyMeaningTurn
      ? (() => {
          const tail = Array.isArray(turnsRaw) ? turnsRaw.slice(-2) : [];
          // 末尾 user は current turn 混入のことがあるので落とす
          if (tail.length > 0 && tail[tail.length - 1]?.role === 'user') {
            return tail.slice(0, -1);
          }
          return tail;
        })()
      : turnsRaw;

  const packMsg: WriterMessage | null = internalPackFixed
    ? { role: 'assistant', content: internalPackFixed }
    : null;

  let messages: WriterMessage[] = [
    { role: 'system', content: systemOne },
    ...(packMsg ? [packMsg] : []),
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
