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
// FLOW_SEED_V1 = new compression-based seed (not legacy MIRROR_FLOW_SEED_V1)
// =============================================

/* eslint-disable @typescript-eslint/no-explicit-any */

import { chatComplete } from '../../../llm/chatComplete';
import type { HistoryDigestV1 } from '../../history/historyDigestV1';
import { injectHistoryDigestV1 } from '../../history/historyDigestV1';
import { decideRecallV1 } from '../../memory/recallGate';
import { buildFlowSeedV1, formatFlowSeedV1 } from '../../seed/seedEngine';
// --- delta engine ---
import { buildMultiDelta } from '@/lib/iros/delta/buildMultiDelta';
import { selectPrimaryDelta } from '@/lib/iros/delta/selectPrimaryDelta';
import { buildTransitionSkeleton } from '@/lib/iros/delta/buildTransitionSkeleton';
import { buildTransition180Candidates } from '@/lib/iros/delta/buildTransition180';
import { selectTransition180 } from '@/lib/iros/delta/selectTransition180';
import { pickTransitionMeaning } from '@/lib/iros/delta/transitionMeaning';
import { buildSeedCanonical } from '@/lib/iros/seed/buildSeedCanonical';
import { detectDeepRead } from '@/lib/iros/deepRead/detectDeepRead';

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
    /^(?:COORD|STATE_CUES_V3|FLOW180_SEED|INTERNAL PACK)\s*\(DO NOT OUTPUT\)\s*:?\s*$/gim,
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
    /COORD\s*\(DO NOT OUTPUT\)|STATE_CUES_V3\s*\(DO NOT OUTPUT\)|FLOW180_SEED\s*\(DO NOT OUTPUT\)|INTERNAL PACK\s*\(DO NOT OUTPUT\)/i.test(
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

  return out;
}

function ensureEndsWithUser(messages: WriterMessage[], finalUserText?: string): WriterMessage[] {
  const out = Array.isArray(messages) ? [...messages] : [];

  const normFinal = typeof finalUserText === 'string' ? norm(finalUserText) : '';
  const last = out[out.length - 1];

  // ✅ 末尾が user でない場合は、finalUserText がある時だけ追加
  if (!last || last.role !== 'user') {
    if (normFinal) out.push({ role: 'user', content: normFinal });
    return out;
  }

  // ✅ 末尾が user の場合は「今回の正本」を優先する
  // - placeholder だけでなく、
  // - 1ターン前の user が末尾に残っているケースもここで置き換える
  if (normFinal) {
    const prev = norm(String(last.content ?? ''));

    if (prev !== normFinal) {
      out[out.length - 1] = { role: 'user', content: normFinal };
      return out;
    }

    if (prev === '（入力なし）' || prev.length === 0) {
      out[out.length - 1] = { role: 'user', content: normFinal };
      return out;
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
    const role = t?.role === 'user' ? 'user' : null;
    if (!role) continue;

    const content0 = String(t?.content ?? t?.text ?? '').trim();
    if (!content0) continue;

    const s0 = stripInternalMarkersFromUserText(content0);
    const s1 = clampStr(s0, MAX_USER_LEN);
    if (!s1) continue;

    out.push({ role: 'user', content: s1 });
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
  console.log('[IROS/FIRST_PASS_ENTRY]');
  const systemPrompt = norm(args.systemPrompt ?? '');

  // ✅ 会話の線（topicDigest / conversationLine）を拾う（短く system 側に固定）
  const topicDigest = clampStr(norm(args.topicDigest ?? ''), 260);
  const conversationLine = clampStr(norm(args.conversationLine ?? ''), 260);
  const rawHistoryText = clampStr(norm(args.historyText ?? ''), 800);
  const internalPackRaw = norm(args.internalPack ?? '');
  const topicDigestV2Raw =
    args.topicDigestV2 && typeof args.topicDigestV2 === 'object'
      ? args.topicDigestV2
      : null;

  const outputPolicyRaw =
    args.outputPolicy && typeof args.outputPolicy === 'object'
      ? args.outputPolicy
      : null;

  const earlyQuestionType = String(
    (args as any)?.questionType ??
      (args as any)?.extra?.question?.questionType ??
      (args as any)?.userContext?.question?.questionType ??
      (args as any)?.userContext?.ctxPack?.question?.questionType ??
      ''
  ).trim();

  const earlyGoalKind = String(
    (args as any)?.goalKind ??
      (args as any)?.extra?.goalKind ??
      (args as any)?.userContext?.goalKind ??
      (args as any)?.userContext?.ctxPack?.goalKind ??
      (args as any)?.userContext?.ctxPack?.replyGoal?.kind ??
      ''
  ).trim();

  const shouldSuppressHistoryText =
    earlyQuestionType === 'structure'

  const historyText = shouldSuppressHistoryText ? '' : rawHistoryText;

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
    historyText
      ? historyText
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

  const flowAny: any = firstNonNull(
    // 🔥 最優先：rephraseEngine直のmeta
    (args as any)?.meta?.extra?.flowEngineResult,
    (args as any)?.meta?.flowEngineResult,

    // 🔥 extra直
    (extra as any)?.flowEngineResult,
    (extra as any)?.flowEngine,

    // ctxPack
    (ctxPack as any)?.flowEngineResult,

    // fallback
    (ctxPack as any)?.flow,
    (extra as any)?.ctxPack?.flow,
    (extra as any)?.flow,

    null,
  );
// 🔥 internalPackRaw の FLOW_V2 から current / prev / delta / energy / futureRandom を復元
let flowFromSeed: any = null;

const currentFlowAny: any = firstNonNull(
  flowAny?.currentFlow,
  flowAny?.current,
  flowFromSeed?.currentFlow,
  null,
);

const previousFlowAny: any = firstNonNull(
  flowAny?.previousFlow,
  flowAny?.previous,
  flowAny?.prev,
  flowFromSeed?.previousFlow,
  null,
);

const futureFlowRaw: any = firstNonNull(
  flowAny?.futureRandom,
  flowAny?.future_flow,
  flowAny?.future,
  flowAny?.futureFlowRandom,
  flowFromSeed?.futureFlowRandom,
  null,
);

let futureFlowAny: any = null;

if (typeof futureFlowRaw === 'string') {
  // 例: e3-S1-neg
  const m = futureFlowRaw.match(/(e\d)-([A-Z]\d)-(pos|neg)/);
  if (m) {
    futureFlowAny = {
      energy: m[1],
      stage: m[2],
      polarity: m[3],
    };
  }
} else if (futureFlowRaw && typeof futureFlowRaw === 'object') {
  futureFlowAny = {
    energy: futureFlowRaw?.energy ?? null,
    stage: futureFlowRaw?.stage ?? null,
    polarity: futureFlowRaw?.polarity ?? null,
  };
} else {
  futureFlowAny = null;
}

console.log('[IROS/FLOW_V2_RECOVERY]', {
  currentFlowAny,
  previousFlowAny,
  deltaFromSeed: flowFromSeed?.delta ?? null,
  energyFromSeed: flowFromSeed?.energy ?? null,
  futureFlowRaw,
});

const userContextExtraForSeed: any =
(args as any)?.userContext?.meta?.extra ??
(args as any)?.userContext?.extra ??
null;

const mirrorFlowV1ForSeed: any =
  firstNonNull(
    (args as any)?.mirrorFlowV1,
    (args as any)?.userContext?.ctxPack?.mirrorFlowV1,
    (args as any)?.userContext?.meta?.extra?.ctxPack?.mirrorFlowV1,
    (args as any)?.userContext?.meta?.extra?.mirrorFlowV1,
    (args as any)?.userContext?.extra?.ctxPack?.mirrorFlowV1,
    (args as any)?.userContext?.extra?.mirrorFlowV1,
    (ctxPack as any)?.mirrorFlowV1,
    (extra as any)?.mirrorFlowV1,
    (extra as any)?.ctxPack?.mirrorFlowV1,
    userContextExtraForSeed?.ctxPack?.mirrorFlowV1,
    userContextExtraForSeed?.mirrorFlowV1,
    null,
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
      mirror?.e_turn,
      mirror?.eTurn,
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
    currentFlowAny?.polarity,
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
    ctxPack?.flows ??
    extra?.flows ??
    null
  ) as any;

  const flowNow = normFlowText(
    firstNonNull<any>(
      flowHints?.now,
      flowHints?.flow_now,
      flowHints?.FLOW_NOW,
      args?.flowNow,
      ctxPack?.flowNow,
      null,
    ),
  );

  const flowNext = normFlowText(
    firstNonNull<any>(
      flowHints?.next,
      flowHints?.flow_next,
      flowHints?.FLOW_NEXT,
      args?.flowNext,
      ctxPack?.flowNext,
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

    const mirrorFlowSeedText = (() => {
      const mf: any = mirrorFlowV1ForSeed;

      const mirror: any =
        mf?.mirror ??
        mf?.mirrorFlow ??
        mf?.mirror_flow ??
        mf?.meta?.mirror ??
        (ctxPack as any)?.mirror ??
        (extra as any)?.mirror ??
        null;

      const flowMf: any =
        mf?.flow ??
        mf?.flowMeta ??
        mf?.flow_meta ??
        mf?.meta?.flow ??
        (ctxPack as any)?.flow ??
        (extra as any)?.flow ??
        null;

      const coordMf: any =
        mf?.coord ??
        mf?.coordinate ??
        mf?.coords ??
        mf?.meta?.coord ??
        null;

      const basedOnMf: any =
        mf?.basedOn ??
        mf?.based_on ??
        mf?.source ??
        mf?.meta?.basedOn ??
        null;

      const currentFlowSeed = String(
        pick(
          typeof currentFlowAny === 'string' ? currentFlowAny : '',
          typeof internalPackRaw === 'string'
            ? (internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '')
            : '',
          '',
        ) ?? '',
      ).trim();

      const eTurnSeed = String(
        pick(
          mirror?.e_turn,
          mirror?.eTurn,
          mf?.e_turn,
          mf?.eTurn,
          (ctxPack as any)?.mirror?.e_turn,
          (ctxPack as any)?.mirror?.eTurn,
          (extra as any)?.mirror?.e_turn,
          (extra as any)?.mirror?.eTurn,
          eTurn,
          typeof internalPackRaw === 'string'
            ? (internalPackRaw.match(/e_turn=([^\n]+)/)?.[1] ?? '')
            : '',
          '',
        ) ?? '',
      ).trim();
      const emotionInnerSeed = String(
        pick(
          mirror?.emotionTexture?.inner,
          mf?.emotionTexture?.inner,
          (ctxPack as any)?.mirror?.emotionTexture?.inner,
          (extra as any)?.mirror?.emotionTexture?.inner,
          '',
        ) ?? '',
      ).trim();

      const emotionNeedSeed = String(
        pick(
          mirror?.emotionTexture?.need,
          mf?.emotionTexture?.need,
          (ctxPack as any)?.mirror?.emotionTexture?.need,
          (extra as any)?.mirror?.emotionTexture?.need,
          '',
        ) ?? '',
      ).trim();

      const emotionProfileObj = firstNonNull<any>(
        mirror?.emotionProfile,
        mf?.emotionProfile,
        mf?.mirror?.emotionProfile,
        mf?.mirrorFlow?.emotionProfile,
        mf?.mirror_flow?.emotionProfile,
        mf?.meta?.mirror?.emotionProfile,
        (ctxPack as any)?.mirror?.emotionProfile,
        (ctxPack as any)?.mirrorFlowV1?.mirror?.emotionProfile,
        (extra as any)?.mirror?.emotionProfile,
        (extra as any)?.mirrorFlowV1?.mirror?.emotionProfile,
        (extra as any)?.ctxPack?.mirror?.emotionProfile,
        (extra as any)?.ctxPack?.mirrorFlowV1?.mirror?.emotionProfile,
        userContextExtraForSeed?.ctxPack?.mirror?.emotionProfile,
        userContextExtraForSeed?.ctxPack?.mirrorFlowV1?.mirror?.emotionProfile,
        userContextExtraForSeed?.mirrorFlowV1?.mirror?.emotionProfile,
        null,
      ) as any;

      const emotionPrimarySeed = String(
        pick(emotionProfileObj?.primary, '') ?? '',
      ).trim();

      const emotionSecondarySeed = Array.isArray(emotionProfileObj?.secondary)
        ? emotionProfileObj.secondary.join(',')
        : '';

      const emotionBalanceSeed =
        emotionProfileObj?.balance && typeof emotionProfileObj.balance === 'object'
          ? JSON.stringify(emotionProfileObj.balance)
          : '';
          console.log(
            '[IROS/writerCalls][EMOTION_PROFILE_SEED_DIAG]',
            JSON.stringify({
              hasEmotionProfileObj: !!emotionProfileObj,
              primary: emotionPrimarySeed,
              secondary: emotionSecondarySeed,
              balance: emotionBalanceSeed,
              hasMirrorEmotionProfile: !!mirror?.emotionProfile,
              hasMfEmotionProfile: !!mf?.emotionProfile,
              hasMfMirrorEmotionProfile: !!mf?.mirror?.emotionProfile,
              hasCtxMirrorEmotionProfile: !!((ctxPack as any)?.mirror?.emotionProfile),
              hasCtxMirrorFlowEmotionProfile: !!((ctxPack as any)?.mirrorFlowV1?.mirror?.emotionProfile),
              hasExtraMirrorEmotionProfile: !!((extra as any)?.mirror?.emotionProfile),
              hasExtraMirrorFlowEmotionProfile: !!((extra as any)?.mirrorFlowV1?.mirror?.emotionProfile),
            }),
          );
      const polarityObj = pick(
        mirror?.polarity,
        mf?.polarity,
        (ctxPack as any)?.mirror?.polarity,
        (extra as any)?.mirror?.polarity,
        null,
      ) as any;

      const polaritySeed = String(
        pick(
          typeof polarityObj === 'string' ? polarityObj : '',
          polarityObj?.out,
          polarityObj?.metaBand,
          polarityObj?.in,
          mirror?.polarity_out,
          mirror?.polarityBand,
          mf?.polarity_out,
          mf?.polarityBand,
          polarity,
          currentFlowSeed.endsWith('-pos') ? 'pos' : '',
          currentFlowSeed.endsWith('-neg') ? 'neg' : '',
          '',
        ) ?? '',
      ).trim();

      const intensitySeed = String(
        pick(
          mirror?.intensity,
          mirror?.strength,
          mf?.intensity,
          mf?.strength,
          (ctxPack as any)?.mirror?.intensity,
          (extra as any)?.mirror?.intensity,
          '',
        ) ?? '',
      ).trim();

      const confidenceSeed = String(
        pick(
          mirror?.confidence,
          mf?.confidence,
          mirror?.mirrorConfidence,
          mf?.mirrorConfidence,
          '',
        ) ?? '',
      ).trim();

      const deltaSeed = String(
        pick(
          flowMf?.delta,
          flowMf?.type,
          flowMf?.returnType,
          mf?.delta,
          mf?.type,
          mf?.returnType,
          typeof internalPackRaw === 'string'
            ? (internalPackRaw.match(/delta=([^\n]+)/)?.[1] ?? '')
            : '',
          '',
        ) ?? '',
      ).trim();

      const returnStreakSeed = String(
        pick(
          flowMf?.returnStreak,
          flowMf?.return_streak,
          mf?.returnStreak,
          mf?.return_streak,
          '',
        ) ?? '',
      ).trim();

      const microSeed = String(
        pick(
          typeof flowMf?.micro === 'boolean' ? String(flowMf.micro) : '',
          typeof mf?.micro === 'boolean' ? String(mf.micro) : '',
          '',
        ) ?? '',
      ).trim();

      const coordStageSeed = String(
        pick(
          coordMf?.stage,
          coordMf?.depth,
          mf?.stage,
          mf?.depth,
          '',
        ) ?? '',
      ).trim();

      const coordBandSeed = String(
        pick(
          coordMf?.band,
          coordMf?.phase,
          mf?.band,
          mf?.phase,
          '',
        ) ?? '',
      ).trim();

      const basedOnKeySeed = String(
        pick(
          basedOnMf?.key,
          basedOnMf?.type,
          mf?.basedOnKey,
          mf?.sourceKey,
          '',
        ) ?? '',
      ).trim();

      const basedOnValueSeed = String(
        pick(
          basedOnMf?.value,
          basedOnMf?.label,
          basedOnMf?.text,
          mf?.basedOnValue,
          mf?.sourceValue,
          '',
        ) ?? '',
      ).trim();

      const lines: string[] = ['MIRROR_FLOW_SEED_V1:'];
      if (currentFlowSeed) lines.push(`current=${currentFlowSeed}`);
      if (eTurnSeed) lines.push(`e_turn=${eTurnSeed}`);
      // emotion_inner / emotion_need は内部推定の生値なので、
      // Writer本文に丸写しされないよう、最終Writer用 pack には実値を入れない。
      // 表現の温度調整は emotion_primary / polarity / intensity / flowDelta 側で扱う。
      // if (emotionInnerSeed) lines.push(`emotion_inner=${emotionInnerSeed}`);
      // if (emotionNeedSeed) lines.push(`emotion_need=${emotionNeedSeed}`);
      if (emotionPrimarySeed) lines.push(`emotion_primary=${emotionPrimarySeed}`);
      if (emotionSecondarySeed) lines.push(`emotion_secondary=${emotionSecondarySeed}`);
      if (emotionBalanceSeed) lines.push(`emotion_balance=${emotionBalanceSeed}`);
      if (polaritySeed) lines.push(`polarity=${polaritySeed}`);
      if (intensitySeed) lines.push(`intensity=${intensitySeed}`);
      if (confidenceSeed) lines.push(`confidence=${confidenceSeed}`);
      if (deltaSeed) lines.push(`flowDelta=${deltaSeed}`);
      if (returnStreakSeed) lines.push(`returnStreak=${returnStreakSeed}`);
      if (microSeed) lines.push(`micro=${microSeed}`);
      if (coordStageSeed) lines.push(`coordStage=${coordStageSeed}`);
      if (coordBandSeed) lines.push(`coordBand=${coordBandSeed}`);
      if (basedOnKeySeed) lines.push(`basedOnKey=${basedOnKeySeed}`);
      if (basedOnValueSeed) lines.push(`basedOnValue=${basedOnValueSeed}`);
      try {
        console.log(
          '[IROS/writerCalls][MIRROR_FLOW_SEED_ENTER]',
          JSON.stringify({
            hasMf: !!mf,
            mfType: typeof mf,
            currentFlowSeed,
            eTurnSeed,
            polaritySeed,
            deltaSeed,
            lineCount: lines.length,
            ctxPackHasMirrorFlowV1: !!((ctxPack as any)?.mirrorFlowV1),
            extraHasMirrorFlowV1: !!((extra as any)?.mirrorFlowV1),
          }),
        );
      } catch {}

      if (lines.length <= 1) return '';
      return lines.join('\n').trim();
    })();

    const seedTextRawBase = String(
      pick(
        // 正本
        args?.internalPack,

        // 現行系
        (args as any)?.flowSeed,
        (ctxPack as any)?.flowSeed,
        (extra as any)?.flowSeed,

        '',
      ) ?? '',
    ).trim();

    const seedTextRaw = (() => {
      if (!mirrorFlowSeedText) return seedTextRawBase;
      if (/MIRROR_FLOW_SEED_V1\b/.test(seedTextRawBase)) return seedTextRawBase;
      return [mirrorFlowSeedText, seedTextRawBase].filter(Boolean).join('\n\n').trim();
    })();
    console.log(
      '[IROS/writerCalls][SEED_TEXT_RAW_DIAG]',
      JSON.stringify({
        hasMirrorFlowSeedText: !!mirrorFlowSeedText,
        mirrorFlowSeedTextHead: String(mirrorFlowSeedText ?? '').slice(0, 200),
        seedTextRawBaseHead: String(seedTextRawBase ?? '').slice(0, 200),
        seedTextRawHead: String(seedTextRaw ?? '').slice(0, 260),
        seedTextRawHasMirrorFlowSeed: /MIRROR_FLOW_SEED_V1\b/.test(String(seedTextRaw ?? '')),
        seedTextRawBaseHasMirrorFlowSeed: /MIRROR_FLOW_SEED_V1\b/.test(String(seedTextRawBase ?? '')),
      })
    );
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
    const s = String(v ?? '').trim();

    if (!s) return '';

    // ❌ 説明・実況系を削る
    let out = s
      .replace(/〜?しています/g, '')
      .replace(/〜?できています/g, '')
      .replace(/〜?している/g, '')
      .replace(/〜?となっている/g, '')
      .replace(/〜?を見ると/g, '')
      .replace(/〜?と感じられます/g, '')
      .replace(/〜?が見えます/g, '')
      .replace(/〜?と言えます/g, '')
      .replace(/〜?できます/g, '');

    // ❌ 主語的な説明語を削る
    out = out
      .replace(/^その問いは、?/g, '')
      .replace(/^ここは、?/g, '')
      .replace(/^いまは、?/g, '');

    // 最後に整形
    out = out.trim();

    return out;
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
      (ctxPack as any)?.flowNow,
      (ctxPack as any)?.flow_now,
      (extra as any)?.flowNow,
      (extra as any)?.flow_now,
      (ctxPack as any)?.flows?.current,
      (args as any)?.flows?.current,
      (extra as any)?.flows?.current,
      (ctxPack as any)?.flows?.now,
      (args as any)?.flows?.now,
      (extra as any)?.flows?.now,
      '',
    ) ?? '',
  );

  const flowNextRaw = String(
    pick(
      flowNext,
      (args as any)?.flowNext,
      (args as any)?.flow_next,
      (ctxPack as any)?.flowNext,
      (ctxPack as any)?.flow_next,
      (extra as any)?.flowNext,
      (extra as any)?.flow_next,
      (ctxPack as any)?.flows?.next,
      (args as any)?.flows?.next,
      (extra as any)?.flows?.next,
      (ctxPack as any)?.flows?.future,
      (args as any)?.flows?.future,
      (extra as any)?.flows?.future,
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
              console.log('[IROS/TRANSITION_SKELETON_FORCE_CHECK]', true);
              // =============================================
              // 🧠 MeaningSkeleton 生成（seed正本）
              // =============================================
              const canonicalSeed = buildSeedCanonical({
                meaningSkeleton: {
                  transitionMeaning:
                    cleanMeaningLine(
                      pick(
                        (ctxPack as any)?.seed?.meaning,
                        (ctxPack as any)?.seed?.transitionMeaning,
                        '',
                      ),
                    ) || null,
                    focus:
                    cleanMeaningLine(
                      pick(
                        (ctxPack as any)?.seed?.focus,
                        latestUserText,
                        '',
                      ),
                    ) || null,
                    oneLineConstraint:
                    (() => {
                      const raw = cleanMeaningLine(
                        pick(
                          (ctxPack as any)?.seed?.oneLineConstraint,
                          '1核心 / 根拠ある意味展開は許可 / 定義・階層化・象徴化は許可 / 根拠のない個人背景・過去・原因は足さない / Δは1つ必ず含める / 質問しない',
                        ),
                      );

                      const normalized = String(raw ?? '')
                        .replace(/説明を増やさない/g, '根拠ある意味展開は許可')
                        .replace(/seedにない新しい具体軸を足さない/g, '根拠のない個人背景・過去・原因は足さない')
                        .replace(/同一テーマ内で自然に広げることは許可/g, '根拠ある意味展開は許可')
                        .replace(/同一テーマ内での視点の深掘りは許可/g, '定義・階層化・象徴化は許可')
                        .replace(/同じ核を言い換えて深める/g, '同じ問いの中で定義・階層・象徴まで深める')
                        .trim();

                      return normalized || '1核心 / 根拠ある意味展開は許可 / 定義・階層化・象徴化は許可 / 根拠のない個人背景・過去・原因は足さない / Δは1つ必ず含める / 質問しない';
                    })(),
                },

                userCore:
                  cleanMeaningLine(
                    pick(
                      (ctxPack as any)?.seed?.focus,
                      latestUserText,
                      '',
                    ),
                  ) || null,

                historyLine:
                  cleanMeaningLine(
                    pick(
                      (args as any)?.historyLine,
                      (ctxPack as any)?.historyLine,
                      latestUserText,
                      '',
                    ),
                  ) || null,

                flow180: (args as any)?.flow180 ?? null,

                writerDirectives: {
                  deltaLine: flowBridge !== '(bridge_unknown)' ? flowBridge : null,
                  flowFrom: String((args as any)?.flow180?.from ?? '').trim() || null,
                  flowTo: String((args as any)?.flow180?.to ?? '').trim() || null,
                  writeConstraints: [
                    '1核心',
                    '根拠ある意味展開は許可',
                    '定義・階層化・象徴化は許可',
                    '根拠のない個人背景・過去・原因は足さない',
                    '同じ問いの中で定義・階層・象徴まで深める',
                    '質問しない',
                  ],
                },

                surfacePlan: {
                  obsCore:
                    cleanMeaningLine(latestUserText) ||
                    cleanMeaningLine(
                      pick(
                        (ctxPack as any)?.seed?.focus,
                        '',
                      ),
                    ) ||
                    null,

                    shiftCore:
                    cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                    cleanMeaningLine((args as any)?.flow180?.sentence) ||
                    cleanMeaningLine(
                      flowBridge !== '(bridge_unknown)'
                        ? flowBridge
                        : '',
                    ) || null,

                  nextCore:
                    cleanMeaningLine(
                      flowNextMeaning !== '(none)'
                        ? flowNextMeaning
                        : '',
                    ) || null,

                  safeCore: null,

                  obsLine:
                    (() => {
                      const v =
                        cleanMeaningLine(latestUserText) ||
                        cleanMeaningLine(
                          pick(
                            (ctxPack as any)?.seed?.focus,
                            '',
                          ),
                        ) ||
                        null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                  shiftLine:
                    (() => {
                      const v =
                        cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                        cleanMeaningLine((args as any)?.flow180?.sentence) ||
                        cleanMeaningLine(
                          flowBridge !== '(bridge_unknown)'
                            ? flowBridge
                            : '',
                        ) || null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                  nextLine:
                    (() => {
                      const v =
                        cleanMeaningLine(
                          flowNextMeaning !== '(none)'
                            ? flowNextMeaning
                            : '',
                        ) || null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                  safeLine: null,
                },

                askBackAllowed: false,
                questionsMax: 0,

                goalKind:
                  String(
                    pick(
                      (ctxPack as any)?.goalKind,
                      (args as any)?.goalKind,
                      (extra as any)?.goalKind,
                      '',
                    ) ?? '',
                  ).trim() || null,
                depthStage: String(depthStage ?? '').trim() || null,
                phase: String(phase ?? '').trim() || null,
                qCode: String(qCode ?? '').trim() || null,
                eTurn: String(eTurn ?? '').trim() || null,
              });

              const transitionSkeleton = buildTransitionSkeleton({
                // 👇 型合わせ（ここ重要）
                transitionMeaning: 'stabilize',
                focus:
                  cleanMeaningLine(canonicalSeed.focus) ||
                  (stateCore !== '(no_state_core)' ? stateCore : null),
                relationContext: flowBridge !== '(bridge_unknown)' ? flowBridge : null,
                oneLineConstraint:
                cleanMeaningLine(canonicalSeed.oneLineConstraint) ||
                '1核心 / 同一テーマ内で自然に広げることは許可 / Δは1つ必ず含める / 質問しない',
              });

              console.log(
                '[IROS/TRANSITION_SKELETON]',
                JSON.stringify({
                  seedMeaning: canonicalSeed.meaning,
                  seedFocus: canonicalSeed.focus,
                  seedConstraint: canonicalSeed.oneLineConstraint,
                  skeleton: transitionSkeleton.skeleton,
                }),
              );

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

              const shiftMeaning = (() => {
                const continuityKind = String((ctxPack as any)?.continuityKind ?? '').trim();
                const sk = String(shiftKindForSeed ?? '').trim();

                if (topicCorrectionGuard.active) {
                  return topicCorrectionGuard.guardLine;
                }

                if (continuityKind === 'same_line') {
                  if (sk === 'clarify_shift') {
                    return '同じ話の線を保ったまま、このテーマのどこを知りたいのかを狭く確かめる';
                  }
                  if (sk === 'stabilize_shift') {
                    return '同じ話の線を保ったまま、揺れている一点を戻って整える';
                  }
                  if (sk === 'distance_shift') {
                    return '同じ話の線を保ったまま、いま苦しさを作っている距離の一点を見る';
                  }
                  if (sk === 'repair_shift') {
                    return '同じ話の線を保ったまま、修復を急がず入口だけを見つける';
                  }
                  if (sk === 'decide_shift') {
                    return '同じ話の線を保ったまま、結論より先に選ぶ基準を定める';
                  }
                  if (sk === 'uncover_shift') {
                    return '同じ話の線を保ったまま、表面の下にある意味をひらく';
                  }
                  return '同じ話の線を保ったまま、いま触る一点だけを狭く定める';
                }

                if (continuityKind === 'continuation') {
                  if (sk === 'clarify_shift') {
                    return '前の流れを引き継ぎ、このテーマのどこを知りたいのかを狭く確かめる';
                  }
                  if (sk === 'stabilize_shift') {
                    return '前の流れを引き継ぎ、揺れている基準を戻って整える';
                  }
                  if (sk === 'distance_shift') {
                    return '前の流れを引き継ぎ、いま苦しさを作っている距離の一点を見る';
                  }
                  if (sk === 'repair_shift') {
                    return '前の流れを引き継ぎ、修復を急がず入口だけを見つける';
                  }
                  if (sk === 'decide_shift') {
                    return '前の流れを引き継ぎ、結論より先に選ぶ基準を定める';
                  }
                  if (sk === 'uncover_shift') {
                    return '前の流れを引き継ぎ、表面の下にある意味をひらく';
                  }
                  return '前の流れを引き継ぎ、いま触る一点だけを狭く定める';
                }

                if (sk === 'clarify_shift') {
                  return '話題を広げず、このテーマのどこを知りたいのかを狭く確かめる';
                }
                if (sk === 'stabilize_shift') {
                  return '進めるより先に、揺れている基準を戻って整える';
                }
                if (sk === 'distance_shift') {
                  return '近づく/離れるの前に、いま苦しさを作っている距離の一点を見る';
                }
                if (sk === 'repair_shift') {
                  return '修復を急がず、安全な入口を1つだけ見つける';
                }
                if (sk === 'decide_shift') {
                  return '結論を急がず、先に選ぶ基準を定める';
                }
                if (sk === 'uncover_shift') {
                  return '表面の説明より先に、奥で引っかかっている意味をひらく';
                }

                return '抽象化せず、いま触る一点だけを狭く定める';
              })();

              const safeMeaning = (() => {
                if (qCode === 'Q3') return '今の安定を崩さずに整え直せば十分';
                if (qCode === 'Q2') return '引っかかりを一気に壊さず、ほどけるところから触れれば十分';
                if (qCode === 'Q1') return '秩序を崩さず、無理のない形で進めれば十分';
                if (qCode === 'Q4') return '怖さを無視せず、軽くできるところから進めれば十分';
                if (qCode === 'Q5') return '火を消さず、小さく戻すだけでも十分';
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

                const goal = String((ctxPack as any)?.goalKind ?? '').trim();

                if (goal === 'resonate') {
                  return '説明を足さず、いま出ている言葉をそのまま薄めずに受け取る';
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
                if (sk === 'narrow_shift') return 'まだ今は、ひとつだけ触れれば十分';
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
                    (args as any)?.userContext?.ctxPack?.question ??
                    (args as any)?.userContext?.meta?.extra?.question ??
                    (args as any)?.userContext?.meta?.extra?.ctxPack?.question ??
                    null;
                  return q && typeof q === 'object' ? q : null;
                })();
                const flow180Block = (() => {
                  try {
                    const flowIdRe =
                      /^(e[1-5])-(S[1-3]|F[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3])-(pos|neg)$/;

                      const currentFlowText = (() => {
                        const fromPack =
                          typeof internalPackRaw === 'string'
                            ? String(
                                internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '',
                              ).trim()
                            : '';

                        if (flowIdRe.test(fromPack)) return fromPack;

                        const raw = firstNonNull(
                          typeof (flowAny as any)?.currentFlow === 'string'
                            ? (flowAny as any).currentFlow
                            : null,
                          typeof (flowAny as any)?.current === 'string'
                            ? (flowAny as any).current
                            : null,
                          typeof currentFlowAny === 'string' ? currentFlowAny : null,
                          '',
                        );

                        const s = String(raw ?? '').trim();
                        return flowIdRe.test(s) ? s : '';
                      })();

                    const previousFlowText = String(
                      firstNonNull(
                        (flowAny as any)?.previousFlow,
                        (flowAny as any)?.prev,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/prev=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    const currentStateId = (() => {
                      const raw = firstNonNull(
                        currentFlowText,
                        currentFlowAny,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      );
                      const s = String(raw ?? '').trim();
                      return flowIdRe.test(s) ? (String(s).trim() as any) : null;
                    })();

                    const previousStateId = (() => {
                      const raw = firstNonNull(
                        previousFlowText,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/prev=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      );
                      const s = String(raw ?? '').trim();
                      return flowIdRe.test(s) ? (String(s).trim() as any) : null;
                    })();

                    const futureStateId = (() => {
                      const fromObject = (() => {
                        const stage = String(futureFlowAny?.stage ?? '').trim();
                        const energy = String(futureFlowAny?.energy ?? '').trim();
                        const polarity = String(futureFlowAny?.polarity ?? '').trim();
                        const id = `${energy}-${stage}-${polarity}`;
                        return flowIdRe.test(id) ? id : '';
                      })();

                      const fromPack =
                        typeof internalPackRaw === 'string'
                          ? String(
                              internalPackRaw.match(/futureRandom=([^\n]+)/)?.[1] ?? '',
                            ).trim()
                          : '';

                      const s = firstNonNull(fromObject, fromPack, '');
                      return flowIdRe.test(String(s).trim()) ? (String(s).trim() as any) : null;
                    })();

                    console.log('[IROS/TRANSITION180][BUILD]', {
                      currentFlowText,
                      previousFlowText,
                      currentStateId,
                      previousStateId,
                      futureStateId,
                    });
                    try {
                      console.log(
                        '[IROS/writerCalls][FLOW180_BLOCK_DIAG]',
                        JSON.stringify({
                          currentFlowText,
                          previousFlowText,
                          currentStateId,
                          previousStateId,
                          futureStateId,
                        })
                      );
                    } catch {}
                    if (!currentStateId) return null;

                    const candidates = buildTransition180Candidates(currentStateId);
                    const picked180 = selectTransition180(candidates, futureStateId);
                    const primary180 = picked180?.primary ?? null;

                    if (!primary180) return null;

                    return [
                      'FLOW180 (DO NOT OUTPUT):',
                      `primary=${primary180.short}`,
                      `from=${primary180.prev ?? '(null)'}`,
                      `to=${primary180.now}`,
                      `deltaType=${primary180.deltaType}`,
                      `sentence=${primary180.sentence}`,
                    ].join('\n');
                  } catch (e) {
                    console.warn('[IROS/TRANSITION180][BUILD][ERROR]', e);
                    return null;
                  }
                })();

                const deltaHint = (() => {
                  try {
                    if (!questionMeta) return null;

                    const layerRaw = String((questionMeta as any)?.layer ?? '')
                      .trim()
                      .toLowerCase();

                    const policyLayer =
                      layerRaw === 'fact'
                        ? 'fact'
                        : layerRaw === 'intent'
                        ? 'intent'
                        : layerRaw === 'interpretation'
                        ? 'creation'
                        : 'fact';

                    const extractETurnFromFlow = (flowLike: unknown): string | null => {
                      const s = String(flowLike ?? '').trim();
                      if (!s || s === '(null)' || s === 'null') return null;
                      const m = s.match(/^(e[1-5])(?:-|$)/i);
                      return m ? m[1].toLowerCase() : null;
                    };

                    const previousFlowText = String(
                      firstNonNull(
                        (flowAny as any)?.previousFlow,
                        (flowAny as any)?.prev,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/prev=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    const currentFlowText = String(
                      firstNonNull(
                        (flowAny as any)?.currentFlow,
                        (flowAny as any)?.current,
                        currentFlowAny,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    const deltas = buildMultiDelta({
                      prev: {
                        e_turn: extractETurnFromFlow(previousFlowText),
                        topic: topicDigest || conversationLine || null,
                        layer: null,
                        intent: intentDir || intentAnchor || null,
                      },
                      now: {
                        e_turn: extractETurnFromFlow(currentFlowText) || eTurn2 || null,
                        topic: latestUserText || null,
                        layer: policyLayer,
                        intent:
                          String((questionMeta as any)?.questionType ?? '').trim() || null,
                      },
                    });

                    const flowIdRe =
                      /^(e[1-5])-(S[1-3]|F[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3])-(pos|neg)$/;

                    const currentStateId = (() => {
                      const raw = firstNonNull(
                        currentFlowText,
                        currentFlowAny,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      );
                      const s = String(raw ?? '').trim();
                      return flowIdRe.test(s) ? (s as any) : null;
                    })();

                    const previousStateId = (() => {
                      const raw = firstNonNull(
                        previousFlowText,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/prev=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      );
                      const s = String(raw ?? '').trim();
                      return flowIdRe.test(s) ? (s as any) : null;
                    })();

                    const futureStateId = (() => {
                      const fromObject = (() => {
                        const stage = String(futureFlowAny?.stage ?? '').trim();
                        const energy = String(futureFlowAny?.energy ?? '').trim();
                        const polarity = String(futureFlowAny?.polarity ?? '').trim();
                        const id = `${energy}-${stage}-${polarity}`;
                        return flowIdRe.test(id) ? id : '';
                      })();

                      const fromPack =
                        typeof internalPackRaw === 'string'
                          ? String(
                              internalPackRaw.match(/futureRandom=([^\n]+)/)?.[1] ?? '',
                            ).trim()
                          : '';

                      const s = firstNonNull(fromObject, fromPack, '');
                      return flowIdRe.test(String(s).trim()) ? (String(s).trim() as any) : null;
                    })();

                    console.log('[IROS/TRANSITION180_INPUT]', {
                      currentFlowText,
                      previousFlowText,
                      currentStateId,
                      previousStateId,
                      futureFlowAny,
                      futureStateId,
                    });

                    const transition180Observed = (() => {
                      if (!currentStateId) {
                        return {
                          currentStateId: null,
                          previousStateId,
                          futureStateId,
                          primary: null,
                          secondary: [],
                        };
                      }

                      const candidates = buildTransition180Candidates(currentStateId);
                      const picked180 = selectTransition180(candidates, futureStateId);

                      return {
                        currentStateId,
                        previousStateId,
                        futureStateId,
                        primary: picked180.primary,
                        secondary: picked180.secondary,
                      };
                    })();

                    console.log('[IROS/TRANSITION180_OBSERVE]', transition180Observed);

                    const primary180 = transition180Observed?.primary;

                    if (!primary180) {
                      return null;
                    }

                    return [
                      'DELTA_HINT (DO NOT OUTPUT):',
                      `primary=${primary180.short}`,
                      `from=${primary180.prev ?? '(null)'}`,
                      `to=${primary180.now}`,
                      `deltaType=${primary180.deltaType}`,
                      `sentence=${primary180.sentence}`,
                    ].join('\n');
                  } catch {
                    return null;
                  }
                })();
                try {
                  console.log('[IROS/delta]', {
                    hasQuestionMeta: !!questionMeta,
                    userText: String((args as any)?.userText ?? ''),
                    questionDomain: String((questionMeta as any)?.domain ?? ''),
                    questionType: String((questionMeta as any)?.questionType ?? ''),
                    questionFocus: String((questionMeta as any)?.tState?.focus ?? ''),
                    questionLayer: String((questionMeta as any)?.layer ?? ''),
                    deltaHint,
                  });
                } catch {}

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
                    (Array.isArray((args as any)?.userContext?.historyForWriter) &&
                      (args as any).userContext.historyForWriter.length > 0
                      ? (args as any).userContext.historyForWriter
                      : Array.isArray((args as any)?.userContext?.ctxPack?.historyForWriter) &&
                          (args as any).userContext.ctxPack.historyForWriter.length > 0
                        ? (args as any).userContext.ctxPack.historyForWriter
                        : Array.isArray((args as any)?.userContext?.turnsForWriter) &&
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
                  const decision = decideRecallV1({
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

                  return {
                    ...decision,
                    __userTextForRecall: userTextForRecall,
                  };
                })();

                const pastStateNoteText = String(
                  (args as any)?.pastStateNoteText ??
                    (args as any)?.extra?.pastStateNoteText ??
                    (args as any)?.userContext?.pastStateNoteText ??
                    (args as any)?.userContext?.meta?.extra?.pastStateNoteText ??
                    '',
                ).trim();

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
                  const qType = String(questionType || '').trim();
                  const flow = String(flowDelta2 || '').trim();

                  if (
                    qType === 'choice' &&
                    /自分の意思と場の圧力|同調圧力|決定の急かし|空気圧/.test(focus)
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
                          '- Explain the structure with enough depth when the user asks for a concept, mechanism, layer, meaning, intention, symbol, or relationship.',
                          '- Do not compress conceptual explanation into a short resonance reply.',
                          '- You may define the concept, divide it into layers, explain transitions, use symbolic language, and end with a distilled insight.',
                          '- Headings and Markdown are allowed when they help understanding; headings should read like part of the prose, not mechanical labels.',
                          '- Do not invent personal background, hidden past, factual causes, or the inner truth of another person.',
                          '- Stay grounded in the user’s question, FLOW, phase, depth, meaningSkeleton, writerDirectives, and transferred structure.',
                          '- Do not end with a question unless the user explicitly asks for one.',
                          '- Finish with the explanation or a concise symbolic closing line.',
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
                            '- When questions_max is 0, do not add a closing question.',
                            '- When questions_max is 1 and askBackAllowed is true, end with exactly one narrow closing question.',
                            '- The closing question must stay on the current topic and must not broaden the scope.',
                            '- The closing question must directly narrow the user’s current statement.',
                            '- Do not ask abstract or broad questions.',
                            '- Do not introduce new topics.',
                          ];
                  }
                })();

                const coreAssertionLine = (() => {
                  const core0 = String(stateCore ?? '').trim();

                  return core0 || '';
                })();

                const futureHintLine = (() => {
                  return null;
                })();

              (args as any).flow180 = (() => {
                if (!flow180Block) return null;

                const pickLine = (key: string) =>
                  String(flow180Block.match(new RegExp(`${key}=([^\\n]+)`))?.[1] ?? '').trim() || null;

                return {
                  primary: pickLine('primary'),
                  from: pickLine('from'),
                  to: pickLine('to'),
                  deltaType: pickLine('deltaType'),
                  sentence: pickLine('sentence'),
                };
              })();

              (args as any).writerDirectives = (() => {
                const incomingWriterDirectives =
                  (args as any)?.writerDirectives && typeof (args as any).writerDirectives === 'object'
                    ? { ...(args as any).writerDirectives }
                    : {};
                    try {
                      console.log(
                        '[IROS/writerCalls][INCOMING_WRITER_DIRECTIVES_KEYS]',
                        JSON.stringify({
                          traceId: (args as any)?.traceId ?? null,
                          conversationId: (args as any)?.conversationId ?? null,
                          userCode: (args as any)?.userCode ?? null,
                          keys: Object.keys(incomingWriterDirectives ?? {}),
                          hasPatternKey:
                            String((incomingWriterDirectives as any)?.pattern_key ?? '').trim().length > 0,
                          hasPatternMode:
                            String((incomingWriterDirectives as any)?.pattern_mode ?? '').trim().length > 0,
                          hasPatternBlockOrder:
                            String((incomingWriterDirectives as any)?.pattern_block_order ?? '').trim().length > 0,
                          hasBlockClosingLine:
                            String((incomingWriterDirectives as any)?.block_closing_line ?? '').trim().length > 0,
                          writeConstraintsLen: Array.isArray((incomingWriterDirectives as any)?.writeConstraints)
                            ? (incomingWriterDirectives as any).writeConstraints.length
                            : 0,
                        })
                      );
                    } catch {}
                const flowLine =
                  String((args as any)?.flow180?.sentence ?? '').trim() || null;

                const goalKindNow = String(
                  (extra as any)?.goalKind ??
                  (args as any)?.extra?.goalKind ??
                  (ctxPack as any)?.goalKind ??
                  ''
                ).trim();

                const touchHint = (() => {
                  const summary = String((ctxPack as any)?.topicDigestV2?.summary ?? '').trim();
                  const situation = String((ctxPack as any)?.topicDigest ?? '').trim();

                  return summary || situation || null;
                })();

                const patternKeyForDefaults = String(
                  incomingWriterDirectives.pattern_key ?? ''
                ).trim();

                const isResonancePattern =
                  patternKeyForDefaults === 'DECLARATION_RESONANCE_V1' ||
                  patternKeyForDefaults === 'NORMAL_RESONANCE_V1';

                const openingMode = isResonancePattern ? '' : 'direct_core';

                const responseLength = isResonancePattern
                  ? 'soft_long'
                  : goalKindNow === 'resonate'
                    ? 'soft_long'
                    : goalKindNow === 'decide'
                      ? 'medium'
                      : goalKindNow === 'uncover'
                        ? 'soft_long'
                        : 'compact';

                const incomingFirstTouch =
                  incomingWriterDirectives.firstTouch && typeof incomingWriterDirectives.firstTouch === 'object'
                    ? incomingWriterDirectives.firstTouch
                    : {};

                const incomingBodyStyle =
                  incomingWriterDirectives.bodyStyle && typeof incomingWriterDirectives.bodyStyle === 'object'
                    ? incomingWriterDirectives.bodyStyle
                    : {};

                const incomingWriteConstraints = Array.isArray(incomingWriterDirectives.writeConstraints)
                  ? incomingWriterDirectives.writeConstraints
                      .map((x: any) => String(x ?? '').trim())
                      .filter(Boolean)
                  : [];
// --- questionType → writerDirectives反映 ---
const currentUserTextForRelationshipReflection = String(
  (args as any)?.userText ??
    (args as any)?.followupText ??
    (args as any)?.inputText ??
    (args as any)?.currentUserText ??
    '',
).trim();
const deepReadUnlockDetection = detectDeepRead({
  currentUserText: currentUserTextForRelationshipReflection,
  previousUserText: null,
  previousAssistantText: null,
  ctxPack,
  args,
});

const stingLevelForDeepReadUnlock =
  deepReadUnlockDetection.meta.stingLevel;

const returnStreakForDeepReadUnlock =
  deepReadUnlockDetection.meta.returnStreak;

const hasRepeatSignalForDeepReadUnlock =
  deepReadUnlockDetection.meta.hasRepeatSignal;

const shouldUnlockDeepReadConstraints =
  deepReadUnlockDetection.reasons.includes('sting_high') ||
  deepReadUnlockDetection.reasons.includes('return_streak') ||
  deepReadUnlockDetection.reasons.includes('repeat_signal');

try {
  console.log('[IROS/writerCalls][DEEP_READ_UNLOCK_CHECK]', {
    currentUserTextForRelationshipReflection,
    stingLevelForDeepReadUnlock,
    returnStreakForDeepReadUnlock,
    hasRepeatSignalForDeepReadUnlock,
    shouldUnlockDeepReadConstraints,
    deepReadLevelForUnlock: deepReadUnlockDetection.level,
    deepReadReasonsForUnlock: deepReadUnlockDetection.reasons,
  });
} catch {}
const isRelationshipReflectionQuestion =
  /(恋愛|彼|彼女|相手|好きな人|連絡|返信|既読|未読|復縁|距離|関係|気持ち)/u.test(
    currentUserTextForRelationshipReflection,
  ) &&
  /(どうしたら|どうすれば|解決|連絡|返信|返事|今の状態|今どう|どう見え|どう映|不安|距離感)/u.test(
    currentUserTextForRelationshipReflection,
  );

const effectiveQuestionType = String(
  (args as any)?.questionType ??
  (args as any)?.extra?.question?.questionType ??
  (args as any)?.userContext?.question?.questionType ??
  (args as any)?.userContext?.ctxPack?.question?.questionType ??
  ''
).trim();
try {
  console.log('[IROS/RELATIONSHIP_REFLECTION_RULE_CHECK]', {
    currentUserTextForRelationshipReflection,
    isRelationshipReflectionQuestion,
    goalKindNow,
    patternKeyForDefaults,
    effectiveQuestionType,
  });
} catch {}
if (effectiveQuestionType === 'truth') {
  incomingWriterDirectives.mode = 'answer_truth_structure';
  incomingWriterDirectives.forbidTopicExpansion = true;
  incomingWriterDirectives.forceSingleConclusion = true;
  incomingWriterDirectives.noAbstractEscape = true;
}

if (effectiveQuestionType === 'structure') {
  incomingWriterDirectives.mode = 'answer_truth_structure';
  incomingWriterDirectives.forbidTopicExpansion = false;
  incomingWriterDirectives.noAbstractEscape = false;
  incomingWriterDirectives.allowStructuralExpansion = true;
}
const isNormalCompressedPattern =
  patternKeyForDefaults === 'NORMAL_COMPRESSED_V1';

  const mergedWriteConstraints = Array.from(
    new Set([
      ...incomingWriteConstraints,

      ...(isRelationshipReflectionQuestion
        ? [
            '関係性・恋愛相談で、解決/どうしたら/連絡/相手の状態に関わる場合は、相手側の様子だけで答えない',
            '相手側に見えている動き、ユーザーの状態が相手像に反映している部分、今こちらが取る距離感を内部で統合する',
            'ユーザーの不安・投影・思い込みが、相手の沈黙や反応をどう重く見せているかを自然に含める',
            '相手の本心や事実を断定しない。「そう映っている」「そう見えやすい」という温度で返す',
            '最後は、追いすぎず離れすぎない距離感、または送るなら短い一言まで落としてよい',
            '番号・見出しは避け、自然な2〜4段落で返す。ただしユーザーが例を求めた場合のみ、番号ではなく「- 」の箇条書きを独立行で使ってよい',
            'このケースでは短く切りすぎない。少なくとも5文以上で、受け止め→相手側の見え方→ユーザー側の反映→距離感の順に自然に展開する',
          ]
        : []),

        ...(isNormalCompressedPattern && !isRelationshipReflectionQuestion && !shouldUnlockDeepReadConstraints
        ? [
            '最初の1文を観測案内の定型で始めない',
            '「いま見えているのは」「いま見ているのは」で始めない',
            '「次に見るのは」「見るなら」「だから、見る場所は」で始めない',
            'OBSは今起きている状態そのものを説明せずにそのまま置く',
            'SHIFTは流れが細くなる一点そのものを説明せずにそのまま置く',
            'NEXTはまだ残っている未解決の一点そのものを置く',
            'SAFEは同じ状態の静かな残りだけを置く',
            '状態を見ている説明文にしない',
            '案内・観測・解説の言い方にしない',
          ]
        : [
            '最初に相手へ触れてから核心に入る',
            '最初の1文は観測で始める',
            '共感だけで終わらない',
            'いまの焦点を一つに絞る',
            'decide時も短く切りすぎず、少し滞在感を持たせてよい',
            'resonate時は説明だけで終わらず、同じ意味を別角度でもう1段だけ展開してよい',
            '1つの結論だけで終わらず、説明→補足→余白の順で最低2段階に展開する',
            '2〜4文で1まとまりにし、少なくとも2まとまり以上で構成する',
            '1つのまとまりに理由・補足・結論を詰め込みすぎない',
            '話題が切り替わる時、理由に移る時、まとめに移る時は段落を分ける',
            'OBSは今起きていることを先に置く',
            'SHIFTはその理由や背景構造を次のまとまりで述べる',
            'NEXTは次に見る一点や分岐点を最後のまとまりで述べる',
          ]),
    ])
  );
const preservedPatternDirectives = Object.fromEntries(
  Object.entries(incomingWriterDirectives).filter(([key, value]) => {
    if (!/^(pattern_|block_)/.test(String(key))) return false;
    return String(value ?? '').trim().length > 0;
  })
);

return {
  ...incomingWriterDirectives,
  ...preservedPatternDirectives,

  mode: incomingWriterDirectives.mode ?? null,

  openingMode,
  responseLength,

  firstTouch: isResonancePattern
    ? {
        ...incomingFirstTouch,
        enabled:
          typeof incomingFirstTouch.enabled === 'boolean'
            ? incomingFirstTouch.enabled
            : goalKindNow === 'resonate',
        hint: incomingFirstTouch.hint ?? touchHint,
        rules: Array.isArray(incomingFirstTouch.rules)
          ? incomingFirstTouch.rules
          : [],
      }
    : {
        ...incomingFirstTouch,
        enabled: goalKindNow === 'resonate',
        hint: touchHint,
        rules: isNormalCompressedPattern
          ? [
              '最初の1文を観測案内の定型にしない',
              '「いま見えているのは」「いま見ているのは」で始めない',
              '「次に見るのは」「見るなら」で始めない',
              '最初の1文は状態そのものを短く自然文で置く',
              '説明や一般論から入らない',
              '問い返しから入らない',
            ]
          : [
              '最初の1文は観測のみ。理由・解釈・結論・一般化は禁止。',
              '最初の1文は、相手の変化・気づき・違和感・届いた感じのいずれかに触れる',
              'ユーザーの言い回し・断定・温度をそのまま受けて返す',
              '構造説明から入らない',
              '一般論から入らない',
              '問い返しから入らない',
              '入力の意味を言い換える前に、まず相手に触れる',
              '受け取りの一言を先に置いてよい',
              '一緒に見ている感じを含めてよい',
              '2〜3文で自然に広げてよい（1文で終わらせない）',
            ],
      },

  bodyStyle: isResonancePattern
    ? {
        ...incomingBodyStyle,
      }
    : {
        ...incomingBodyStyle,
        coreFirst: true,
        allowSoftExpand: true,
        minSentences:
          typeof incomingBodyStyle.minSentences === 'number'
            ? incomingBodyStyle.minSentences
            : goalKindNow === 'decide'
              ? 4
              : 3,
        maxSentences:
          typeof incomingBodyStyle.maxSentences === 'number'
            ? incomingBodyStyle.maxSentences
            : goalKindNow === 'decide'
              ? 7
              : 6,
        allowEmpathicBridge:
          typeof incomingBodyStyle.allowEmpathicBridge === 'boolean'
            ? incomingBodyStyle.allowEmpathicBridge
            : true,
        allowGentleRephrase:
          typeof incomingBodyStyle.allowGentleRephrase === 'boolean'
            ? incomingBodyStyle.allowGentleRephrase
            : isResonancePattern
              ? false
              : true,
        forbidTopicExpansion:
          typeof incomingBodyStyle.forbidTopicExpansion === 'boolean'
            ? incomingBodyStyle.forbidTopicExpansion
            : true,
        delayClosure:
          typeof incomingBodyStyle.delayClosure === 'boolean'
            ? incomingBodyStyle.delayClosure
            : true,
        preferBlockSplit:
          typeof incomingBodyStyle.preferBlockSplit === 'boolean'
            ? incomingBodyStyle.preferBlockSplit
            : true,
        maxSentencesPerBlock:
          typeof incomingBodyStyle.maxSentencesPerBlock === 'number'
            ? incomingBodyStyle.maxSentencesPerBlock
            : 2,
        minBlocks:
          typeof incomingBodyStyle.minBlocks === 'number'
            ? incomingBodyStyle.minBlocks
            : 2,
      },

  flowLine,
  deltaLine: bestShiftDirection || null,
  flowFrom: String((args as any)?.flow180?.from ?? '').trim() || null,
  flowTo: String((args as any)?.flow180?.to ?? '').trim() || null,

  writeConstraints: isResonancePattern
    ? incomingWriteConstraints
    : mergedWriteConstraints,
};
              })();

              const flowSeedV1 = buildFlowSeedV1({
                flow: {
                  current: (() => {
                    const localCurrentFlowSeed = String(
                      pick(
                        typeof currentFlowAny === 'string' ? currentFlowAny : '',
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/current=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    return localCurrentFlowSeed || null;
                  })(),

                  prev:
                    (typeof previousFlowAny === 'string'
                      ? String(previousFlowAny).trim()
                      : '') ||
                    (typeof internalPackRaw === 'string'
                      ? String(internalPackRaw.match(/prev=([^\n]+)/)?.[1] ?? '').trim()
                      : '') ||
                    null,

                  delta: (() => {
                    const localDeltaSeed = String(
                      pick(
                        (flow as any)?.delta,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/delta=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    return localDeltaSeed || null;
                  })(),

                  energy: (() => {
                    const localETurnSeed = String(
                      pick(
                        eTurn,
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/e_turn=([^\n]+)/)?.[1] ?? '')
                          : '',
                        typeof internalPackRaw === 'string'
                          ? (internalPackRaw.match(/energy=([^\n]+)/)?.[1] ?? '')
                          : '',
                        '',
                      ) ?? '',
                    ).trim();

                    return localETurnSeed || null;
                  })(),

                  futureRandom: (() => {
                    const fromInternalPack = String(
                      typeof internalPackRaw === 'string'
                        ? (internalPackRaw.match(/futureRandom=([^\n]+)/)?.[1] ?? '')
                        : ''
                    ).trim();
                    if (fromInternalPack) return fromInternalPack;

                    const stage = String(futureFlowAny?.stage ?? '').trim();
                    const energy = String(futureFlowAny?.energy ?? '').trim();
                    const polarity = String(futureFlowAny?.polarity ?? '').trim();
                    if (stage && energy && polarity) return `${energy}-${stage}-${polarity}`;

                    const fromFlowObj = String((flow as any)?.futureRandom ?? '').trim();
                    return fromFlowObj || null;
                  })(),
                },

                goalKind: pick(
                  (extra as any)?.goalKind,
                  (args as any)?.extra?.goalKind,
                  null,
                ),

                memoryLine: (() => {
                  const rawMemoryLine = String(
                    (args as any)?.memoryLine ??
                      (extra as any)?.memoryLine ??
                      ''
                  ).trim();

                  const isHeavyInput =
                    (extra as any)?.goalKind === 'uncover' ||
                    (args as any)?.extra?.goalKind === 'uncover';

                  if (!rawMemoryLine) return null;

                  if (isHeavyInput) {
                    return rawMemoryLine.startsWith('recent_turn_only:')
                      ? rawMemoryLine
                      : null;
                  }

                  return rawMemoryLine;
                })(),

                userCore: (() => {
                  const latest = String(latestUserText ?? '').trim();
                  const core = String(coreAssertionLine ?? '').trim();

                  const isHeavyInput =
                    (extra as any)?.goalKind === 'uncover' ||
                    (args as any)?.extra?.goalKind === 'uncover';

                  const base = latest || core || null;
                  if (!base) return null;

                  if (futureHintLine) {
                    return `${base}\n${futureHintLine}`;
                  }

                  if (isHeavyInput) {
                    return base;
                  }

                  return base;
                })(),

                historyLine: (() => {
                  const rawHistory = String(
                    (args as any)?.conversationLine ??
                      (extra as any)?.conversationLine ??
                      (args as any)?.topicDigest ??
                      (extra as any)?.topicDigest ??
                      ''
                  ).trim();

                  const isHeavyInput =
                    (extra as any)?.goalKind === 'uncover' ||
                    (args as any)?.extra?.goalKind === 'uncover';

                  if (!rawHistory) return futureHintLine ?? null;

                  if (isHeavyInput) return futureHintLine ?? null;

                  return [rawHistory, futureHintLine].filter(Boolean).join('\n');
                })(),

                meaningSkeleton: (args as any).meaningSkeleton ?? null,
                flow180: (args as any).flow180 ?? null,
                writerDirectives: (args as any).writerDirectives ?? null,

                surfacePlan: {
                  obsCore:
                    cleanMeaningLine(latestUserText) ||
                    cleanMeaningLine(
                      pick(
                        (ctxPack as any)?.seed?.focus,
                        '',
                      ),
                    ) ||
                    null,

                  shiftCore:
                    cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                    cleanMeaningLine((args as any)?.flow180?.sentence) ||
                    cleanMeaningLine(
                      flowBridge !== '(bridge_unknown)'
                        ? flowBridge
                        : '',
                    ) || null,

                  nextCore:
                    cleanMeaningLine(
                      flowNextMeaning !== '(none)'
                        ? flowNextMeaning
                        : '',
                    ) || null,

                    safeCore:
                    cleanMeaningLine((args as any)?.flow180?.sentence) ||
                    cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                    cleanMeaningLine(latestUserText) ||
                    null,
                  obsLine:
                    (() => {
                      const v =
                        cleanMeaningLine(latestUserText) ||
                        cleanMeaningLine(
                          pick(
                            (ctxPack as any)?.seed?.focus,
                            '',
                          ),
                        ) ||
                        null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                  shiftLine:
                    (() => {
                      const v =
                        cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                        cleanMeaningLine((args as any)?.flow180?.sentence) ||
                        cleanMeaningLine(
                          flowBridge !== '(bridge_unknown)'
                            ? flowBridge
                            : '',
                        ) || null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                  nextLine:
                    (() => {
                      const v =
                        cleanMeaningLine(
                          flowNextMeaning !== '(none)'
                            ? flowNextMeaning
                            : '',
                        ) || null;
                      if (!v) return null;
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),

                    safeLine:
                    (() => {
                      const v =
                        cleanMeaningLine((args as any)?.flow180?.sentence) ||
                        cleanMeaningLine((args as any)?.writerDirectives?.deltaLine) ||
                        cleanMeaningLine(latestUserText) ||
                        'そこだけが、静かに残っています。';
                      return /[。！？]$/.test(v) ? v : `${v}。`;
                    })(),
                },

                depthStage: depthStage || null,
                phase: phase || null,
                qCode: qCode || null,
                eTurn: eTurn || null,

                askBackAllowed: (args as any)?.askBackAllowed ?? null,
                questionsMax: (args as any)?.questionsMax ?? null,
              });
                const flowSeedTextRaw = (() => {
                  return formatFlowSeedV1(flowSeedV1).trim();
                })();

                const flowSeedTextLegacy = (() => {
                  const legacy = flowSeedTextRaw
                    .replace(/\n*SEED\s*\(DO NOT OUTPUT\):[\s\S]*$/i, '')
                    .trim();

                  const flowOnly =
                    legacy.match(/FLOW:\n[\s\S]*?(?=\n\nCONTEXT:|$)/)?.[0] ?? '';

                  return flowOnly.trim();
                })();

                const cleanLegacySeed = (text: string) =>
                  text
                    .replace(/\nCONTEXT:\n[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/g, '')
                    .replace(/\nFLOW:\n[\s\S]*?(?=\n[A-Z0-9_ ]+\(DO NOT OUTPUT\):|$)/g, '')
                    .replace(/historyLine=.*\n?/g, '')
                    .replace(/memoryLine=.*\n?/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                const cleanCanonicalSeed = (text: string) =>
                  text
                    .replace(/historyLine=.*\n?/g, '')
                    .replace(/memoryLine=.*\n?/g, '')
                    .replace(/\n{3,}/g, '\n\n')
                    .trim();

                // 🔥 旧FLOWブロック削除（DO NOT OUTPUTノイズ排除）
                const internalPackRawCleaned =
                  typeof internalPackRaw === 'string'
                    ? internalPackRaw.replace(/\nFLOW:\n[\s\S]*?(?=\n[A-Z_]+:|$)/g, '')
                    : internalPackRaw;

                    const flowV2Text = '';

                    const canonicalSeedText = (() => {
                      const primaryCanonicalText =
                        flowSeedV1?.canonical?.text
                          ? cleanCanonicalSeed(String(flowSeedV1.canonical.text))
                          : '';

                      const fallbackCanonicalText =
                        canonicalSeed?.text
                          ? cleanCanonicalSeed(String(canonicalSeed.text))
                          : '';

                      const raw = primaryCanonicalText || fallbackCanonicalText;
                      if (!raw) return '';

                      const differenceExists = /\nDIFFERENCE:\n/.test(`\n${raw}`);
                      if (differenceExists) return raw;

                      const deltaType =
                        String(flow180Block?.match(/deltaType=([^\n]+)/)?.[1] ?? '').trim() || null;

                      const deltaReason =
                        deltaType === 'stage_energy'
                          ? 'まだどこまでを今ここで言い切るかは決まりきっていない。'
                          : deltaType === 'energy_shift'
                            ? 'まだ気持ちの揺れが残っている。'
                            : deltaType === 'stage_shift'
                              ? 'まだ次の一歩をひとつに決めきらずに残っている。'
                              : null;

                      if (!deltaReason) return raw;
                      if (/\nDELTA:\n/.test(raw)) return raw;

                      return raw.replace(
                        /(MEANING:\n[^\n]+)/,
                        `$1\n\nDELTA:\n${deltaReason}`
                      );
                    })();

                const writerDirectivesBlock = (() => {

                  try {
                    console.log(
                      '[IROS/writerCalls][WD_ENTRY_CHECK]',
                      JSON.stringify({
                        traceId: (args as any)?.traceId ?? null,
                        conversationId: (args as any)?.conversationId ?? null,
                        userCode: (args as any)?.userCode ?? null,
                        hasWriterDirectives: !!(args as any)?.writerDirectives,
                        writerDirectivesType: typeof (args as any)?.writerDirectives,
                        hasTopSlotDecision: !!(args as any)?.slotDecision,
                        topSlotDecisionKeys:
                          (args as any)?.slotDecision && typeof (args as any).slotDecision === 'object'
                            ? Object.keys((args as any).slotDecision)
                            : [],
                        hasUserContext: !!(args as any)?.userContext,
                        hasCtxPack: !!(args as any)?.userContext?.ctxPack,
                        hasCtxSlotDecision: !!(args as any)?.userContext?.ctxPack?.slotDecision,
                      })
                    );
                  } catch {}

                  const wd = (args as any)?.writerDirectives;
                  if (!wd || typeof wd !== 'object') return '';

                  const lines: string[] = ['WRITER_DIRECTIVES (DO NOT OUTPUT):'];

                  const deepRevealLine = String((wd as any)?.deepRevealLine ?? '').trim();
                  const forceUseDeepReveal = (wd as any)?.forceUseDeepReveal === true;

                  if (deepRevealLine) {
                    lines.push(`deepRevealLine=${deepRevealLine}`);
                    lines.push(`forceUseDeepReveal=${forceUseDeepReveal ? 'true' : 'false'}`);
                  }
                  const slotDecision = (args as any)?.slotDecision ?? (args as any)?.userContext?.ctxPack?.slotDecision;

                  const patternKeyForSlotGate = String((wd as any)?.pattern_key ?? '').trim();
                  const isDetailPatternWriter =
                    patternKeyForSlotGate === 'IR_DETAIL_V1' ||
                    patternKeyForSlotGate === 'NORMAL_DETAIL_V1' ||
                    patternKeyForSlotGate === 'NORMAL_RESONANCE_V1' ||
                    patternKeyForSlotGate === 'DECLARATION_RESONANCE_V1';

                  try {
                    const topSd = (args as any)?.slotDecision;
                    const uc = (args as any)?.userContext;
                    const cp = (args as any)?.userContext?.ctxPack;
                    const ctxSd = (args as any)?.userContext?.ctxPack?.slotDecision;
                    const sd = topSd ?? ctxSd;

                    console.log(
                      '[IROS/writerCalls][SLOT_DECISION_CHECK_STR]',
                      JSON.stringify({
                        traceId: (args as any)?.traceId ?? null,
                        conversationId: (args as any)?.conversationId ?? null,
                        userCode: (args as any)?.userCode ?? null,
                        hasTopSlotDecision: !!topSd,
                        topSlotDecisionKeys:
                          topSd && typeof topSd === 'object' ? Object.keys(topSd) : [],
                        hasUserContext: !!uc,
                        hasCtxPack: !!cp,
                        ctxPackKeys:
                          cp && typeof cp === 'object' ? Object.keys(cp) : [],
                        hasCtxSlotDecision: !!ctxSd,
                        ctxSlotDecisionKeys:
                          ctxSd && typeof ctxSd === 'object' ? Object.keys(ctxSd) : [],
                        hasSlotDecision: !!sd,
                        slotDecisionKeys:
                          sd && typeof sd === 'object' ? Object.keys(sd) : [],
                        slotOrder:
                          Array.isArray((sd as any)?.order) ? (sd as any).order : [],
                        writerDirectiveKeys:
                          (args as any)?.writerDirectives &&
                          typeof (args as any).writerDirectives === 'object'
                            ? Object.keys((args as any).writerDirectives)
                            : [],
                        patternKeyForSlotGate,
                        isDetailPatternWriter,
                      })
                    );
                  } catch {}

                  if (!isDetailPatternWriter && slotDecision && typeof slotDecision === 'object') {
                    const slotOrder = Array.isArray(slotDecision?.order)
                      ? slotDecision.order
                          .map((v: unknown) => String(v ?? '').trim())
                          .filter(Boolean)
                      : [];

                    const slotEmphasis =
                      slotDecision?.emphasis && typeof slotDecision.emphasis === 'object'
                        ? slotDecision.emphasis
                        : null;

                    const slotWeights =
                      slotDecision?.weights && typeof slotDecision.weights === 'object'
                        ? slotDecision.weights
                        : null;

                    if (slotOrder.length > 0) {
                      lines.push(`slot_order=${slotOrder.join(',')}`);
                      lines.push(`slot_opening_role=${slotOrder[0]}`);
                      if (slotOrder[1]) lines.push(`slot_second_role=${slotOrder[1]}`);
                      if (slotOrder[2]) lines.push(`slot_third_role=${slotOrder[2]}`);
                      lines.push('slot_safe_last=true');
                    }

                    if (slotEmphasis) {
                      const obs = Number((slotEmphasis as any)?.OBS ?? 1);
                      const shift = Number((slotEmphasis as any)?.SHIFT ?? 1);
                      const next = Number((slotEmphasis as any)?.NEXT ?? 1);
                      const safe = Number((slotEmphasis as any)?.SAFE ?? 1);

                      lines.push(`slot_emphasis_obs=${obs}`);
                      lines.push(`slot_emphasis_shift=${shift}`);
                      lines.push(`slot_emphasis_next=${next}`);
                      lines.push(`slot_emphasis_safe=${safe}`);
                    }

                    if (slotWeights) {
                      const obs = Number((slotWeights as any)?.OBS ?? 0);
                      const shift = Number((slotWeights as any)?.SHIFT ?? 0);
                      const next = Number((slotWeights as any)?.NEXT ?? 0);
                      const safe = Number((slotWeights as any)?.SAFE ?? 0);

                      lines.push(`slot_weight_obs=${obs}`);
                      lines.push(`slot_weight_shift=${shift}`);
                      lines.push(`slot_weight_next=${next}`);
                      lines.push(`slot_weight_safe=${safe}`);
                    }
                  }
                  const firstTouch = wd?.firstTouch;
                  const firstTouchHint =
                    firstTouch && typeof firstTouch === 'object'
                      ? String(firstTouch?.hint ?? '').trim()
                      : '';

                  let continuationRequested = false;

                  // 🔥 continuation（続き接続モード）
                  try {
                    const recallUsedLocal = Boolean((args as any)?.userContext?.ctxPack?.recallUsed);
                    const sourceText =
                      firstTouchHint ||
                      String((args as any)?.echoGuardUserText ?? '') ||
                      String((args as any)?.userText ?? '');

                    const isExplicitRequestLocal =
                      /この前|続き|前に言ってた|前に|前の話(?:し)?|前の流れ|つなげて|続きとして/.test(sourceText);

                    continuationRequested = Boolean(isExplicitRequestLocal);

                    if (continuationRequested) {
                      lines.push('continuation_mode=true');
                      lines.push('first_line_must_be_connection=true');
                      lines.push('forbid_observation_opening=true');
                      lines.push('opening_style=connect_previous_flow');
                    }
                  } catch {}

                  const openingMode = String(wd?.openingMode ?? '').trim();
                  const responseLength = String(wd?.responseLength ?? '').trim();

                  if (openingMode) lines.push(`openingMode=${openingMode}`);
                  if (responseLength) lines.push(`responseLength=${responseLength}`);

                  if (firstTouch && typeof firstTouch === 'object') {
                    const enabled = firstTouch?.enabled === true ? 'true' : 'false';
                    const hint = String(firstTouch?.hint ?? '').trim();

                    lines.push(`firstTouch.enabled=${enabled}`);
                    if (hint) lines.push(`firstTouch.hint=${hint}`);

                    const rules = Array.isArray(firstTouch?.rules) ? firstTouch.rules : [];
                    const filteredRules = rules
                      .map((x: any) => String(x ?? '').trim())
                      .filter(Boolean)
                      .filter((rule: string) => {
                        if (!continuationRequested) return true;
                        return (
                          !rule.includes('最初の1文は「相手の状態を見ている観測文」にする')
                        );
                      });
                  }

                  const bodyStyle = wd?.bodyStyle;
                  if (bodyStyle && typeof bodyStyle === 'object') {
                    if (typeof bodyStyle?.coreFirst === 'boolean') {
                      lines.push(`bodyStyle.coreFirst=${bodyStyle.coreFirst ? 'true' : 'false'}`);
                    }
                    if (typeof bodyStyle?.allowSoftExpand === 'boolean') {
                      lines.push(`bodyStyle.allowSoftExpand=${bodyStyle.allowSoftExpand ? 'true' : 'false'}`);
                    }
                    if (typeof bodyStyle?.minSentences === 'number') {
                      lines.push(`bodyStyle.minSentences=${bodyStyle.minSentences}`);
                    }
                    if (typeof bodyStyle?.maxSentences === 'number') {
                      lines.push(`bodyStyle.maxSentences=${bodyStyle.maxSentences}`);
                    }
                    if (typeof bodyStyle?.allowEmpathicBridge === 'boolean') {
                      lines.push(
                        `bodyStyle.allowEmpathicBridge=${bodyStyle.allowEmpathicBridge ? 'true' : 'false'}`
                      );
                    }
                    if (typeof bodyStyle?.allowGentleRephrase === 'boolean') {
                      lines.push(
                        `bodyStyle.allowGentleRephrase=${bodyStyle.allowGentleRephrase ? 'true' : 'false'}`
                      );
                    }
                    if (typeof bodyStyle?.forbidTopicExpansion === 'boolean') {
                      lines.push(
                        `bodyStyle.forbidTopicExpansion=${bodyStyle.forbidTopicExpansion ? 'true' : 'false'}`
                      );
                    }
                    if (typeof bodyStyle?.delayClosure === 'boolean') {
                      lines.push(`bodyStyle.delayClosure=${bodyStyle.delayClosure ? 'true' : 'false'}`);
                    }
                    if (typeof bodyStyle?.preferBlockSplit === 'boolean') {
                      lines.push(
                        `bodyStyle.preferBlockSplit=${bodyStyle.preferBlockSplit ? 'true' : 'false'}`
                      );
                    }
                    if (typeof bodyStyle?.maxSentencesPerBlock === 'number') {
                      lines.push(`bodyStyle.maxSentencesPerBlock=${bodyStyle.maxSentencesPerBlock}`);
                    }
                    if (typeof bodyStyle?.minBlocks === 'number') {
                      lines.push(`bodyStyle.minBlocks=${bodyStyle.minBlocks}`);
                    }
                  }

                  const flowLine = String(wd?.flowLine ?? '').trim();
                  const deltaLine = String(wd?.deltaLine ?? '').trim();
                  const flowFrom = String(wd?.flowFrom ?? '').trim();
                  const flowTo = String(wd?.flowTo ?? '').trim();

                  if (flowLine) lines.push(`flowLine=${flowLine}`);
                  if (deltaLine) lines.push(`deltaLine=${deltaLine}`);
                  if (flowFrom) lines.push(`flowFrom=${flowFrom}`);
                  if (flowTo) lines.push(`flowTo=${flowTo}`);

                  const patternKey = String(wd?.pattern_key ?? '').trim();
                  const patternMode = String(wd?.pattern_mode ?? '').trim();
                  const patternBlockOrder = String(wd?.pattern_block_order ?? '').trim();

                  if (patternKey) lines.push(`pattern_key=${patternKey}`);
                  if (patternMode) lines.push(`pattern_mode=${patternMode}`);
                  if (patternBlockOrder) lines.push(`pattern_block_order=${patternBlockOrder}`);

                  const patternBlockKeys = [
                    'block_current_state',
                    'block_misrecognition_negation',
                    'block_structural_reframe',
                    'block_breakdown_core_gap',
                    'block_breakdown_defense',
                    'block_breakdown_rejection_target',
                    'block_reading_direction',
                    'block_concrete_sort_axis',
                    'block_concrete_sort_boundary',
                    'block_concrete_sort_redesign',
                    'block_felt_acceptance_point',
                    'block_conclusion',
                    'block_sting_point',
                    'block_caution',
                    'block_closing_line',
                  ] as const;

                  for (const key of patternBlockKeys) {
                    const value = String((wd as any)?.[key] ?? '').trim();
                    if (value) lines.push(`${key}=${value}`);
                  }

                  const writeConstraints = Array.isArray(wd?.writeConstraints) ? wd.writeConstraints : [];
                  writeConstraints
                    .map((x: any) => String(x ?? '').trim())
                    .filter(Boolean)
                    .forEach((rule: string, i: number) => {
                      lines.push(`writeConstraint${i + 1}=${rule}`);
                    });

                  return lines.join('\n').trim();
                })();

                const seedBlocksForWriter = [
                  canonicalSeedText,
                  flowV2Text,
                ]
                  .filter((x) => norm(x));

                const seedBlockForWriter = seedBlocksForWriter.join('\n\n');

                const injectedHead = [seedBlockForWriter]
                .filter((x) => norm(x))
                .join('\n\n');

              const originalInternalPackForWriter = String(args?.internalPack ?? '').trim();

              const internalPackFixed = [
                injectedHead.trim(),
                originalInternalPackForWriter,
              ]
                .filter((x) => String(x ?? '').trim().length > 0)
                .join('\n\n')
                .trim();

              if (internalPackFixed.includes('FLOW_V2')) {
                const mCurrent = internalPackFixed.match(/current=([^\n]+)/);
                const mPrev = internalPackFixed.match(/prev=([^\n]+)/);
                const mDelta = internalPackFixed.match(/delta=([^\n]+)/);
                const mEnergy = internalPackFixed.match(/energy=([^\n]+)/);
                const mFuture = internalPackFixed.match(/futureRandom=([^\n]+)/);

                flowFromSeed = {
                  currentFlow: mCurrent?.[1]?.trim() || null,
                  previousFlow: mPrev?.[1]?.trim() || null,
                  delta: mDelta?.[1]?.trim() || null,
                  energy: mEnergy?.[1]?.trim() || null,
                  futureFlowRandom: mFuture?.[1]?.trim() || null,
                };
              }

              console.log('[IROS/FLOW_V2_RECOVERY_SRC]', {
                source: 'internalPackFixed',
                hasFlowV2: internalPackFixed.includes('FLOW_V2'),
                currentFlow: flowFromSeed?.currentFlow ?? null,
                previousFlow: flowFromSeed?.previousFlow ?? null,
                delta: flowFromSeed?.delta ?? null,
                energy: flowFromSeed?.energy ?? null,
                futureFlowRandom: flowFromSeed?.futureFlowRandom ?? null,
              });
                  let injectedPack = internalPackFixed;

                  if (futureFlowAny) {
                    injectedPack += `\nfutureRandom=${JSON.stringify({
                      stage: futureFlowAny?.stage ?? null,
                      e_turn: futureFlowAny?.energy ?? null,
                      polarity: futureFlowAny?.polarity ?? null,
                    })}`;
                  }

                  try {
                    const packNorm = norm(injectedPack);
                    const h = packNorm.slice(0, 900);

                    const flowMatch = packNorm.match(
                      /FLOW_V2(?:\s*\(DO NOT OUTPUT\))?:|FLOW_CONTEXT(?:\s*\(DO NOT OUTPUT\))?:|FLOW_MEANING(?:\s*\(DO NOT OUTPUT\))?:/
                    );
                      const flowIdx = flowMatch ? flowMatch.index ?? -1 : -1;
                      const flowSnippet =
                        flowIdx >= 0 ? packNorm.slice(flowIdx, Math.min(packNorm.length, flowIdx + 520)) : '';

                      const hasOpenness =
                        /(?:^|\n)OPENNESS(?:\n|$)/.test(packNorm) ||
                        /tLayerHint=|itOk=/.test(packNorm);

                      const hasWriterDirectives =
                        /(?:^|\n)WRITER_DIRECTIVES(?:\n|$)/.test(packNorm) ||
                        /tone=|maxLines=|slotPolicy=|rotationMention=/.test(packNorm);

                      console.log('[IROS/writerCalls][INJECTED_PACK_HEAD_RAW]', h);

                      console.log('[IROS/writerCalls][INJECTED_PACK_HEAD]', {
                        traceId: (args as any)?.traceId ?? null,
                        conversationId: (args as any)?.conversationId ?? null,
                        packLen: packNorm.length,
                        head: h,
                        hasCOORD: /COORD\s*\(DO NOT OUTPUT\)/.test(packNorm),
                        hasPolarity: /polarity=/.test(packNorm),
                        hasSA: /sa=/.test(packNorm),

                        // 旧 itx_step / itx_reason に加えて、FLOW_SEED_V1 内の itOk も検知する
                        hasITX:
                          /itx_step=|itx_reason=/.test(packNorm) ||
                          /itOk=/.test(packNorm),

                          hasFuture:
                          /future=/.test(packNorm) ||
                          /futureRandom=/.test(packNorm),

                        hasStateCues: /STATE_CUES_V3\s*\(DO NOT OUTPUT\)/.test(packNorm),

                        hasFlowMeaning:
                        /(?:^|\n)(?:FLOW_MEANING|FLOW_V2)(?:\s*\(DO NOT OUTPUT\))?:/.test(packNorm) ||
                          /hook=/.test(packNorm) ||
                          /tension=/.test(packNorm) ||
                          /openLoop=/.test(packNorm),

                        hasMirrorFlowSeed:
                          /FLOW_SEED_V1\b/.test(packNorm) ||
                          /FLOW:\s*\n/.test(packNorm),
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

// writer には delta を混ぜない。
// delta はここでは補助観測にとどめ、pack 正本は internalPackFixed に固定する。

const internalPackForWriterSource = internalPackFixed;

const irMeta =
  (args as any)?.meta?.extra?.irMeta ??
  (args as any)?.meta?.irMeta ??
  (args as any)?.meta?.extra?.ctxPack?.irMeta ??
  (args as any)?.meta?.ctxPack?.irMeta ??
  (args as any)?.userContext?.meta?.extra?.irMeta ??
  (args as any)?.userContext?.meta?.irMeta ??
  (args as any)?.userContext?.ctxPack?.irMeta ??
  (args as any)?.userContext?.extra?.ctxPack?.irMeta ??
  null;

const isDetailMode =
  (args as any)?.meta?.extra?.detailMode === true ||
  (args as any)?.meta?.detailMode === true ||
  (args as any)?.meta?.extra?.ctxPack?.detailMode === true ||
  (args as any)?.meta?.ctxPack?.detailMode === true ||
  (args as any)?.userContext?.meta?.extra?.detailMode === true ||
  (args as any)?.userContext?.meta?.detailMode === true ||
  (args as any)?.userContext?.ctxPack?.detailMode === true ||
  (args as any)?.userContext?.extra?.ctxPack?.detailMode === true;
  console.log('[DEBUG][IR_META_CHECK]', {
    isDetailMode,
    hasIrMeta: !!irMeta,
    irMeta,
  });
const irMetaBlock = (() => {
  if (!isDetailMode || !irMeta || typeof irMeta !== 'object') return '';

  const obs = String((irMeta as any)?.observationResult ?? '').trim();
  const aware = String((irMeta as any)?.awarenessText ?? '').trim();
  const summary = String((irMeta as any)?.summaryText ?? '').trim();

  if (!obs && !aware && !summary) return '';

  return [
    'IR_META (DO NOT OUTPUT):',
    obs ? `observation=${obs}` : '',
    aware ? `awareness=${aware}` : '',
    summary ? `summary=${summary}` : '',
  ]
    .filter(Boolean)
    .join('\n');
})();

const diagnosisFollowup =
  (args as any)?.ctxPack?.diagnosisFollowup ??
  (args as any)?.extra?.diagnosisFollowup ??
  (args as any)?.extra?.ctxPack?.diagnosisFollowup ??
  (args as any)?.meta?.extra?.diagnosisFollowup ??
  (args as any)?.meta?.extra?.ctxPack?.diagnosisFollowup ??
  (args as any)?.meta?.ctxPack?.diagnosisFollowup ??
  (args as any)?.userContext?.meta?.extra?.diagnosisFollowup ??
  (args as any)?.userContext?.meta?.extra?.ctxPack?.diagnosisFollowup ??
  (args as any)?.userContext?.ctxPack?.diagnosisFollowup ??
  false;

const followupKind =
  (args as any)?.ctxPack?.followupKind ??
  (args as any)?.extra?.followupKind ??
  (args as any)?.extra?.ctxPack?.followupKind ??
  (args as any)?.meta?.extra?.followupKind ??
  (args as any)?.meta?.extra?.ctxPack?.followupKind ??
  (args as any)?.meta?.ctxPack?.followupKind ??
  (args as any)?.userContext?.meta?.extra?.followupKind ??
  (args as any)?.userContext?.meta?.extra?.ctxPack?.followupKind ??
  (args as any)?.userContext?.ctxPack?.followupKind ??
  null;

const diagnosisFollowupBlock = (() => {
    if (!diagnosisFollowup) return '';

    const kind = String(followupKind ?? 'concretize').trim();

    const obs = String((irMeta as any)?.observationResult ?? '').trim();
    const aware = String((irMeta as any)?.awarenessText ?? '').trim();
    const summary = String((irMeta as any)?.summaryText ?? '').trim();
    const target = String((irMeta as any)?.targetLabel ?? '').trim();
    const isSelfTarget =
      /^(自分|今の自分|わたし|私|僕|俺|自分自身)$/u.test(target);

    const targetDisplay =
      target && !isSelfTarget && !/(さん|様|先生|くん|ちゃん)$/u.test(target)
        ? `${target}さん`
        : target;

    const kindRule =
      kind === 'action'
        ? 'Return exactly one next step derived from the diagnosis. Do not ask the user to narrow scope. Do not request clarification.'
        : kind === 'rephrase'
          ? 'Rephrase the diagnosis briefly in plain language. Keep the diagnosis meaning. Do not switch to advice.'
          : kind === 'deepen'
            ? 'Explain why this diagnosis is happening and what background structure supports it. Do not switch topic.'
            : 'Explain the last diagnosis itself. Expand abstract phrases into concrete states, mismatches, and possible actions. Do not ask the user what they mean.';

    return [
      'DIAGNOSIS_FOLLOWUP (DO NOT OUTPUT):',
      `FOLLOWUP_KIND=${kind || 'concretize'}`,
      target ? `DIAGNOSIS_TARGET=${target}` : '',
      targetDisplay ? `DIAGNOSIS_TARGET_DISPLAY=${targetDisplay}` : '',
      targetDisplay
        ? `TARGET_NAME_RULE=When referring to the diagnosis target in prose, use "${targetDisplay}" instead of "${target}". Keep stored target labels unchanged.`
        : '',
      obs ? `DIAGNOSIS_OBSERVATION=${obs}` : '',
      aware ? `DIAGNOSIS_STATE=${aware}` : '',
      summary ? `DIAGNOSIS_SUMMARY=${summary}` : '',
      `RULE=${kindRule}`,
      'FORBIDDEN=Do not ask the user to specify what they want concretized. Do not broaden to a normal practical question. Do not return to previous normal topics.',
    ]
      .filter(Boolean)
      .join('\n');
  })();

  const internalPackForWriter = (() => {
    const seedInstructionCoreForPack = (() => {
      try {
        const source = String(seedTextRawBase ?? '').trim();

        const fromSeedInstruction = (() => {
          if (!source) return '';

          const marker = 'この意味を優先し、それ以外の文脈は補助として扱ってください。';
          const markerIndex = source.indexOf(marker);
          if (markerIndex < 0) return '';

          const afterMarker = source.slice(markerIndex + marker.length).trim();
          const firstLine = afterMarker
            .split('\n')
            .map((line) => line.trim())
            .find((line) => {
              if (!line) return false;
              if (/^(INTERNAL PACK|STATE:|META:|FLOW:|FLOW_STORY:|FLOW_V2)/.test(line)) return false;
              if (/^(inputKind=|directTask=|depthStage=|phase=|qCode=|openingPolicy=|intentBand=|tLayerHint=|itOk=|e_turn=)/.test(line)) return false;
              return true;
            });

          return String(firstLine ?? '').replace(/\s+/g, ' ').trim();
        })();

        if (fromSeedInstruction) return fromSeedInstruction;

        const fallbackFromUserText = String((args as any)?.userText ?? '')
          .replace(/\s+/g, ' ')
          .trim();

        return fallbackFromUserText;
      } catch {
        return '';
      }
    })();

    const rewritePackWithSeedInstructionCore = (content: string) => {
      const seed = seedInstructionCoreForPack;
      if (!seed) return content;
      if (seed.length > 240) return content;
      if (/^ユーザーの最後の発話に/.test(seed)) return content;
      if (/^@/.test(seed)) return content;
      const emotionInnerForPack = String(
        String(mirrorFlowSeedText ?? '').match(/^emotion_inner=([^\n]+)/m)?.[1] ?? '',
      ).trim();

      const obsCoreForPack =
        'まず質問への定義・軸を短く置く。emotion_inner / emotion_need が存在しても、OBSの先頭を感情の言い換えだけで開始しない。emotion_inner の実値は本文に丸出しせず、必要な場合だけ後続文の温度調整に使う';

      const obsLineForPack =
        '最初の一文は、感情の受け文ではなく、問いに対する分かりやすい定義または見取り図から開始する。emotion_inner の実値をそのまま書かない';

      return String(content ?? '')
        .replace(/(CONTEXT:\n)[^\n]*/u, `$1${seed}`)
        .replace(/(FOCUS:\n)[^\n]*/u, `$1${seed}`)
        .replace(/(OBS=)[^\n]*/u, `$1${obsCoreForPack}`)
        .replace(/(NEXT=)[^\n]*/u, '$1必要以上に構造化せず、会話として少しだけ返す')
        .replace(/(OBS_LINE=)[^\n]*/u, `$1${obsLineForPack}`)
        .replace(/(NEXT_LINE=)[^\n]*/u, '$1丸写しではなく、感じ取った強さだけを短く返す。');
    };

    const userIntentBridgeBlock = (() => {
      const userTextRaw = String(
        (args as any)?.userText ??
          (args as any)?.followupText ??
          (args as any)?.inputText ??
          (args as any)?.currentUserText ??
          '',
      ).trim();

      const normalizeLabel = (value: unknown): string => {
        return String(value ?? '')
          .replace(/さん|様|先生|くん|ちゃん/g, '')
          .replace(/\s+/g, ' ')
          .trim();
      };

      const lastIrDiagnosis =
        ((ctxPack as any)?.lastIrDiagnosis && typeof (ctxPack as any).lastIrDiagnosis === 'object')
          ? (ctxPack as any).lastIrDiagnosis
          : ((extra as any)?.lastIrDiagnosis && typeof (extra as any).lastIrDiagnosis === 'object')
            ? (extra as any).lastIrDiagnosis
            : ((args as any)?.userContext?.ctxPack?.lastIrDiagnosis &&
                typeof (args as any).userContext.ctxPack.lastIrDiagnosis === 'object')
              ? (args as any).userContext.ctxPack.lastIrDiagnosis
              : null;

      const targetRaw =
        (irMeta as any)?.targetLabel ??
        (irMeta as any)?.target ??
        (lastIrDiagnosis as any)?.targetLabel ??
        (lastIrDiagnosis as any)?.target ??
        (ctxPack as any)?.targetLabel ??
        (extra as any)?.targetLabel ??
        null;

      const targetLabel = normalizeLabel(targetRaw);

      const targetMentioned =
        !!targetLabel &&
        normalizeLabel(userTextRaw).includes(targetLabel);

      const objectLabel = (() => {
        const t = userTextRaw;
        if (/製品シェア/u.test(t)) return '製品シェア';
        if (/シェア|共有/u.test(t)) return 'シェア';
        if (/LINE|ライン/u.test(t)) return 'LINE';
        if (/連絡/u.test(t)) return '連絡';
        if (/返信|返事/u.test(t)) return '返信';
        if (/診断結果|診断内容|診断/u.test(t)) return '診断結果';
        if (/共鳴/u.test(t)) return '共鳴';
        return null;
      })();

      const hasDiagnosisContext =
        diagnosisFollowup === true ||
        (
          targetMentioned &&
          (
            ((irMeta as any) && typeof (irMeta as any) === 'object') ||
            !!lastIrDiagnosis
          )
        );

      const intentKind = (() => {
        const t = userTextRaw;

        const asksTiming =
          /今|まだ|早い|タイミング|時期|今じゃない|今ではない|今すぐ|あとで|後で/u.test(t) &&
          /いい|良い|どう|使う|使用|シェア|共有|渡す|出す|送る|連絡|返信|返事|始める|進める/u.test(t);

        if (asksTiming) {
          return 'ask_timing';
        }

        if (/どう渡|渡し方|伝え方|言い方|送れば|共有の仕方|シェアの仕方/u.test(t)) {
          return 'ask_how_to_deliver';
        }

        if (/いいですか|良いですか|べき|判断|どちら|迷って|ありですか|やめた方|した方/u.test(t)) {
          return 'ask_judgement';
        }

        if (/とは|意味|状態|示します|どんな|何ですか|なんですか|出来ますか|できますか/u.test(t)) {
          return 'ask_definition';
        }

        if (hasDiagnosisContext) return 'diagnosis_followup';

        return 'continue';
      })();

      const sourceContext =
        hasDiagnosisContext
          ? 'last_ir_diagnosis'
          : ((ctxPack as any)?.historyDigestV1 || (extra as any)?.historyDigestV1)
            ? 'history'
            : 'current_text';

      const targetPart = targetLabel ? `${targetLabel}さん` : 'この相手';
      const objectPart = objectLabel ?? '今回の話';

      const userWants = (() => {
        if (intentKind === 'ask_timing') {
          return `${targetPart}に${objectPart}を今出してよいか、まだ早いかを判断してほしい`;
        }
        if (intentKind === 'ask_how_to_deliver') {
          return `${targetPart}に${objectPart}をどう渡せば届きやすいかを見てほしい`;
        }
        if (intentKind === 'ask_judgement') {
          return `${objectPart}について、進めてよいか・控えるべきかを判断してほしい`;
        }
        if (intentKind === 'ask_definition') {
          return `${objectPart}の意味や状態を、分かる形で説明してほしい`;
        }
        if (intentKind === 'diagnosis_followup') {
          return `${targetPart}の診断結果を前提に、今の相談へつなげて見てほしい`;
        }
        return '直前までの流れを踏まえて、今の発話の用事に合う形で返してほしい';
      })();

      const answerShould = (() => {
        if (intentKind === 'ask_timing') {
          return '1文目で「送って大丈夫です。ただし、短く軽くが合います」または「今は送らない方がいいです」のように、可否を先に答える。理由は診断や文脈から1〜2点だけに絞り、最後は具体的な渡し方・言い方で閉じる';
        }
        if (intentKind === 'ask_how_to_deliver') {
          return '具体的な渡し方・言い方・距離感まで落とす';
        }
        if (intentKind === 'ask_judgement') {
          return '判断を曖昧にせず、進める/控える/軽く試すのどれに寄るかを返す';
        }
        if (intentKind === 'ask_definition') {
          return '定義から入り、説明だけで終わらず、見分け方や使える入口まで返す';
        }
        if (intentKind === 'diagnosis_followup') {
          return '診断結果の内容を材料にして、今の相談に直接答える';
        }
        return '入力文の整理ではなく、ユーザーが今してほしいことへ直接返す';
      })();

      const isConsultAnswerIntent =
        intentKind === 'ask_timing' ||
        intentKind === 'ask_judgement' ||
        intentKind === 'ask_how_to_deliver';

      const avoid = [
        '入力文の構造整理だけで終わらない',
        'ユーザーの用事を聞き返さない',
        '一般論にしない',
        hasDiagnosisContext ? '診断結果を無視しない' : '',
        intentKind === 'ask_timing' ? '今かまだかをぼかさない' : '',
        intentKind === 'ask_judgement' ? '判断をぼかさない' : '',
        intentKind === 'ask_how_to_deliver' ? '渡し方を抽象語だけで終わらせない' : '',
        isConsultAnswerIntent ? '見出しを使わない' : '',
        isConsultAnswerIntent ? '「いま見えていること」「いま分けて見たいこと」「ここから整理する順番」「いまのまとめ」のような分析レポート型にしない' : '',
        isConsultAnswerIntent ? '同じ意味を「渡る」「届く」「温度」「順番」「置き方」などで何度も言い換えない' : '',
        isConsultAnswerIntent ? '「静かに」「場」「流れ」「素直になります」で締めない' : '',
      ].filter(Boolean);

      return [
        'USER_INTENT_BRIDGE_V1 (DO NOT OUTPUT):',
        `intentKind=${intentKind}`,
        targetLabel ? `targetLabel=${targetLabel}` : '',
        objectLabel ? `objectLabel=${objectLabel}` : '',
        `sourceContext=${sourceContext}`,
        `userWants=${userWants}`,
        `answerShould=${answerShould}`,
        isConsultAnswerIntent ? 'consultAnswerMode=enabled' : '',
        isConsultAnswerIntent
          ? 'outputContract=見出しなしの3〜4段落。1段落目で結論、2段落目で理由、3段落目で具体的な行動・渡し方・言い方、最後はユーザーがそのまま使える判断または文例に近い形で閉じる'
          : '',
        `avoid=${avoid.join(' / ')}`,
      ]
        .filter(Boolean)
        .join('\n');
    })();

    const consultAnswerContractBlock = (() => {
      const bridge = String(userIntentBridgeBlock ?? '');

      const enabled =
        /consultAnswerMode=enabled/u.test(bridge) ||
        /intentKind=(ask_timing|ask_judgement|ask_how_to_deliver)/u.test(bridge);

      if (!enabled) return '';

      return [
        'CONSULT_ANSWER_CONTRACT (DO NOT OUTPUT):',
        'priority=highest',
        'purpose=ユーザーの相談に、整理ではなく答えとして返す',
        'format=見出しなしの自然文3〜4段落',
        'paragraph1=最初の1文で可否を答える。「送って大丈夫です。ただし、短く軽くが合います」「今は送らない方がいいです」のように判断を先に出す。「今すぐ送るより」「いったん整えてから」だけで始めない',
        'paragraph2=理由は1〜2点だけ。入力文を分析せず、ユーザーが判断に使える理由だけを書く',
        'paragraph3=具体的な行動・渡し方・言い方を出す。可能ならそのまま使える短い文例に近づける',
        'paragraph4=締めは抽象語ではなく、今どうするかで閉じる',
        'forbid_headings=いま見えていること / いま分けて見たいこと / ここから整理する順番 / いまのまとめ / 🔍 / 🎯 / ✅',
        'forbid_style=分析レポート型 / 同じ意味の言い換え反復 / 状態観測だけ / 抽象的な余韻',
        'forbid_tail=静かに / 場 / 流れ / 素直になります / 置き方 / 温度 / 順番 だけで締めない',
        'must_not=ユーザーの発話を整理するだけで終わらない',
        'must=ユーザーが今どうすればいいかを、迷わず読める形にする',
      ].join('\n');
    })();

    let base = [
      [
        mirrorFlowSeedText,
        rewritePackWithSeedInstructionCore(String(internalPackForWriterSource ?? '')),
      ]
        .filter(Boolean)
        .join('\n\n'),
      irMetaBlock,
      diagnosisFollowupBlock,
      userIntentBridgeBlock,
      consultAnswerContractBlock,

      (() => {
        const currentUserText = String(
          (args as any)?.userText ??
            (args as any)?.followupText ??
            (args as any)?.inputText ??
            (args as any)?.currentUserText ??
            '',
        )
          .replace(/\s+/g, ' ')
          .trim();

        const detection = detectDeepRead({
          currentUserText,
          previousUserText: null,
          previousAssistantText: null,
          ctxPack,
          args,
        });

        if (!detection.shouldOpen) return '';

        return [
          'DEEP_READ_HINT (DO NOT OUTPUT):',
          `CURRENT_USER=${currentUserText}`,
          `level=${detection.level}`,
          detection.reasons.length ? `reasons=${detection.reasons.join(',')}` : '',
          detection.meta.stingLevel ? `stingLevel=${detection.meta.stingLevel}` : '',
          `returnStreak=${detection.meta.returnStreak}`,
          detection.meta.hasRepeatSignal ? 'repeatSignal=true' : '',
          detection.hints.length ? `hints=${detection.hints.join(' / ')}` : '',
          'MODE=発話の奥に出ている反応パターンを軽く読む',
          'RULE=無意識を読んだ、見抜いた、筒抜け、とは出力しない',
          'RULE=人格診断・決めつけ・断定にしない',
          'RULE=相手の本心や事実確認には使わない',
          'RULE=言葉の選び方、回避、強まり、繰り返し、急な確定欲求を「いま表に出ている反応の癖」として扱う',
          'RULE=必要な場合だけ、自然文で一段深く触れる',
          'RULE=状態観測だけで終わらず、ユーザーが扱える形へ戻す',
        ]
          .filter(Boolean)
          .join('\n');
      })(),

      (() => {
        const relationCtxPack =
          ((args as any)?.userContext?.ctxPack &&
          typeof (args as any).userContext.ctxPack === 'object'
            ? (args as any).userContext.ctxPack
            : null) ??
          ((args as any)?.userContext?.meta?.extra?.ctxPack &&
          typeof (args as any).userContext.meta.extra.ctxPack === 'object'
            ? (args as any).userContext.meta.extra.ctxPack
            : null) ??
          ((args as any)?.meta?.extra?.ctxPack &&
          typeof (args as any).meta.extra.ctxPack === 'object'
            ? (args as any).meta.extra.ctxPack
            : null) ??
          ((args as any)?.extra?.ctxPack &&
          typeof (args as any).extra.ctxPack === 'object'
            ? (args as any).extra.ctxPack
            : null) ??
          ((ctxPack as any) && typeof (ctxPack as any) === 'object'
            ? (ctxPack as any)
            : null);

        const memory =
          relationCtxPack?.relationshipMemory ??
          (ctxPack as any)?.relationshipMemory ??
          null;

        const relationFocus =
          relationCtxPack?.relationFocus ??
          (ctxPack as any)?.relationFocus ??
          null;
          try {
            console.log('[IROS/writerCalls][RELATION_MEMORY_HINT_SOURCE]', {
              traceId: (args as any)?.traceId ?? null,
              conversationId: (args as any)?.conversationId ?? null,
              userCode: (args as any)?.userCode ?? null,
              relationCtxPackKeys:
                relationCtxPack && typeof relationCtxPack === 'object'
                  ? Object.keys(relationCtxPack)
                  : [],
              hasRelationshipMemory: !!memory,
              hasRelationFocus: !!relationFocus,
              memoryKeys:
                memory && typeof memory === 'object'
                  ? Object.keys(memory)
                  : [],
              relationId:
                relationCtxPack?.relationId ??
                memory?.relation_id ??
                null,
              displayName:
                memory?.display_name ??
                null,
            });
          } catch {}
          const currentUserText = String(
            (args as any)?.userText ??
              (args as any)?.followupText ??
              (args as any)?.inputText ??
              (args as any)?.currentUserText ??
              '',
          )
            .replace(/\s+/g, ' ')
            .trim();

          const historyForRelationHint =
            (Array.isArray((args as any)?.userContext?.historyForWriter) &&
            (args as any).userContext.historyForWriter.length > 0
              ? (args as any).userContext.historyForWriter
              : Array.isArray((args as any)?.userContext?.ctxPack?.historyForWriter) &&
                  (args as any).userContext.ctxPack.historyForWriter.length > 0
                ? (args as any).userContext.ctxPack.historyForWriter
                : Array.isArray((relationCtxPack as any)?.historyForWriter)
                  ? (relationCtxPack as any).historyForWriter
                  : Array.isArray((ctxPack as any)?.historyForWriter)
                    ? (ctxPack as any).historyForWriter
                    : []) as any[];

          const previousUserTextForRelationHint =
            [...historyForRelationHint]
              .reverse()
              .map((m: any) => {
                const role = String(m?.role ?? m?.type ?? '').trim().toLowerCase();
                if (role !== 'user') return '';

                return String(
                  m?.content ??
                    m?.text ??
                    m?.message ??
                    m?.userText ??
                    '',
                )
                  .replace(/\s+/g, ' ')
                  .trim();
              })
              .find(Boolean) ?? '';

          const isRelationshipDeicticFollowup =
            /(この状況|この場合|この件|それ|これ|今の状態|どうしたら解決|どうすれば解決|解決しますか|どうしたらいい|どうすればいい)/u.test(
              currentUserText,
            ) &&
            /(彼|彼女|相手|恋愛|連絡|返信|返事|不安|距離|沈黙)/u.test(
              previousUserTextForRelationHint,
            );

            const relationId = String(
              (ctxPack as any)?.relationId ??
                relationCtxPack?.relationId ??
                memory?.relation_id ??
                memory?.relationId ??
                '',
            ).trim();

            const displayName = String(
              memory?.display_name ??
                memory?.displayName ??
                relationCtxPack?.displayName ??
                (ctxPack as any)?.displayName ??
                '',
            ).trim();

            const confidence =
              typeof memory?.confidence === 'number' ? memory.confidence : null;

            const hasRelationshipMemory =
              memory != null &&
              typeof memory === 'object' &&
              (
                relationId ||
                displayName ||
                Array.isArray(memory?.facts) ||
                Array.isArray(memory?.patterns) ||
                Array.isArray(memory?.safe_openers) ||
                Array.isArray(memory?.pressure_triggers) ||
                Array.isArray(memory?.user_reaction_pattern) ||
                Array.isArray(memory?.unresolved_topics)
              );

            const relationshipAliasText = [
              currentUserText,
              previousUserTextForRelationHint,
            ]
              .join(' ')
              .replace(/\s+/g, ' ')
              .trim();

            const hasGenericRelationshipAlias =
              /(彼|彼女|相手|好きな人|元彼|元カノ|パートナー|恋愛|連絡|返信|返事|距離|不安|大事にされたい)/u.test(
                relationshipAliasText,
              );

            const shouldSuggestRelationshipDisplayName =
              Boolean(relationId) &&
              !displayName &&
              hasGenericRelationshipAlias &&
              (hasRelationshipMemory || !!relationFocus || isRelationshipDeicticFollowup);

            if (!hasRelationshipMemory && !relationFocus && !isRelationshipDeicticFollowup) return '';

            const pickStrings = (value: unknown, limit: number): string[] => {
              if (!Array.isArray(value)) return [];
              return value
                .map((item: any) => {
                  if (typeof item === 'string') return item;
                  if (item && typeof item === 'object') {
                    return String(
                      item.note ??
                        item.value ??
                        item.key ??
                        '',
                    ).trim();
                  }
                  return '';
                })
                .map((v) => String(v ?? '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(0, limit);
            };

            const facts = pickStrings(memory?.facts, 3);
            const patterns = pickStrings(memory?.patterns, 3);
            const safeOpeners = pickStrings(memory?.safe_openers, 3);
            const pressureTriggers = pickStrings(memory?.pressure_triggers, 3);
            const userReactionPattern = pickStrings(memory?.user_reaction_pattern, 3);
            const unresolvedTopics = pickStrings(memory?.unresolved_topics, 3);

            return [
              'RELATION_MEMORY_HINT (DO NOT OUTPUT):',
              `CURRENT_USER=${currentUserText}`,
              previousUserTextForRelationHint ? `previousUserText=${previousUserTextForRelationHint.slice(0, 180)}` : '',
              isRelationshipDeicticFollowup ? 'continuationHint=直前の恋愛相談を指す参照語フォローの可能性がある' : '',
              relationId ? `relationId=${relationId}` : '',
              displayName ? `displayName=${displayName}` : '',
              shouldSuggestRelationshipDisplayName ? 'relationshipDisplayNameMissing=true' : '',
              shouldSuggestRelationshipDisplayName
                ? 'RULE=同じ相手として今後も見ていけるように、最後に一度だけ、本名ではなく呼び名でよいことを短く添える'
                : '',
              shouldSuggestRelationshipDisplayName
                ? 'RULE=呼び名確認は重くしない。「本名でなくて大丈夫なので、この相手の呼び名だけ決めておけます」程度にする'
                : '',
              shouldSuggestRelationshipDisplayName
                ? 'RULE=呼び名確認では、個人情報を求める感じにしない。「Aさん」「彼」「好きな人」などで扱えると伝える'
                : '',
              confidence != null ? `confidence=${confidence}` : '',
              relationFocus ? `relationFocus=${JSON.stringify(relationFocus)}` : '',
              facts.length ? `facts=${facts.join(' / ')}` : '',
              patterns.length ? `patterns=${patterns.join(' / ')}` : '',
              safeOpeners.length ? `safeOpeners=${safeOpeners.join(' / ')}` : '',
              pressureTriggers.length ? `pressureTriggers=${pressureTriggers.join(' / ')}` : '',
              userReactionPattern.length ? `userReactionPattern=${userReactionPattern.join(' / ')}` : '',
              unresolvedTopics.length ? `unresolvedTopics=${unresolvedTopics.join(' / ')}` : '',
              'RULE=現在のユーザー文を最優先する',
              'RULE=「この状況」「それ」「この場合」などの参照語は、直前履歴が恋愛相談ならその続き候補として扱う',
              'RULE=relationId または displayName がある場合だけ、同じ相手の続き候補として強めに扱う',
              'RULE=「彼」「相手」だけで相手が曖昧な場合は、過去記憶を強く使わない',
              'RULE=過去記憶は断定に使わず、距離感・不安・反応パターン・安全な言葉の補助としてだけ使う',
              'RULE=別の相手の可能性がある場合は、この記憶を使わない',
              'RULE=相手の本心や事実確認としては使わない',
            ]
            .filter(Boolean)
            .join('\n');
      })(),
      (() => {
        const currentUserText = String(
          (args as any)?.userText ??
            (args as any)?.followupText ??
            (args as any)?.inputText ??
            (args as any)?.currentUserText ??
            '',
        )
          .replace(/\s+/g, ' ')
          .trim();

        const historyForWriterSource =
          (Array.isArray((args as any)?.userContext?.historyForWriter) &&
            (args as any).userContext.historyForWriter.length > 0
            ? (args as any).userContext.historyForWriter
            : Array.isArray((args as any)?.userContext?.ctxPack?.historyForWriter) &&
                (args as any).userContext.ctxPack.historyForWriter.length > 0
              ? (args as any).userContext.ctxPack.historyForWriter
              : Array.isArray((ctxPack as any)?.historyForWriter)
                ? (ctxPack as any).historyForWriter
                : []) as any[];

        const previousAssistantText =
          [...historyForWriterSource]
            .reverse()
            .map((m: any) => {
              const role = String(m?.role ?? m?.type ?? '').trim().toLowerCase();
              if (role !== 'assistant' && role !== 'iros' && role !== 'model') return '';

              const content = String(
                m?.content ??
                  m?.text ??
                  m?.message ??
                  m?.assistantText ??
                  '',
              )
                .replace(/\s+/g, ' ')
                .trim();

              if (!content) return '';
              if (/^(SEED|INTERNAL PACK|WRITER_DIRECTIVES|PATTERN_OUTPUT_CONTRACT)/.test(content)) return '';

              return content;
            })
            .find(Boolean) ?? '';
            const isRelationshipInfluenceReframe =
            (
              /(私|自分|気持ち|意識|状態|波動|エネルギー|内側).*(変えたら|変わったら|整えたら|上げたら|戻したら).*(彼|彼女|相手|関係|現実).*(変わる|変わります|変化する|動く|連絡|返信|返事)/u.test(
                currentUserText,
              ) ||
              /(彼|彼女|相手|関係|現実).*(変わる|変わります|変化する|動く|連絡|返信|返事).*(私|自分|気持ち|意識|状態|波動|エネルギー|内側).*(変えたら|変わったら|整えたら|上げたら|戻したら)/u.test(
                currentUserText,
              ) ||
              /(私の気持ちを変えたら|私の意識を変えたら|自分が変われば|私が変われば|波動を変えたら|状態を変えたら|意識を変えたら|内側を変えたら)/u.test(
                currentUserText,
              ) ||
              /(彼|彼女|相手).*(変えるには|変えたい|動かしたい|動いてほしい|反応を変えたい|態度を変えたい|連絡させたい|返信させたい|返事させたい)/u.test(
                currentUserText,
              ) ||
              /(彼の反応を変えたい|彼女の反応を変えたい|相手の反応を変えたい|彼の態度を変えたい|彼女の態度を変えたい|相手の態度を変えたい|彼に動いてほしい|彼女に動いてほしい|相手に動いてほしい|彼から連絡させたい|彼女から連絡させたい|相手から連絡させたい|連絡させたい|返信させたい|返事させたい)/u.test(
                currentUserText,
              )
            ) &&
            /(彼|彼女|相手|関係|恋愛|連絡|返信|返事|鏡|反映|現実|反応|態度)/u.test(
              `${currentUserText} ${previousAssistantText}`,
            );

          if (isRelationshipInfluenceReframe) {
            return [
              'RELATIONSHIP_INFLUENCE_REFRAME (DO NOT OUTPUT):',
              `CURRENT_USER=${currentUserText}`,
              previousAssistantText ? `PREVIOUS_ASSISTANT=${previousAssistantText.slice(0, 360)}` : '',
              'MODE=自分の状態が変わることで、関係の場・届き方・相手像がどう変わるかを説明する',
              'RULE=相手を直接変えられる、相手が必ず変わる、とは断定しない',
              'RULE=ただし、自分の不安・力み・追いかける反応が変わると、関係の空気・届き方・距離感は変わる可能性があると返す',
              'RULE=変える対象は「彼」ではなく、「自分の立ち位置」「不安から追わない位置」「言葉の出し方」だと説明する',
              'RULE=彼を操作するために自分を変える、という方向にはしない',
              'RULE=鏡のように映っていた相手像も、ユーザーの見方や反応が変わることで、拒絶ではなく余地として見え方が変わることを説明する',
              'RULE=ユーザーの状態が「彼を変えたい」から「自分の位置を変えると関係の場が変わる」に移るように返す',
              'RULE=必要なら、「彼を変えたい」ではなく「私は不安から追わない位置に戻る」という具体的な変換文を出す',
              'OUTPUT=普通の会話文で、3〜5段落。番号・見出し・箇条書きにしない',
            ]
              .filter(Boolean)
              .join('\n');
          }
            const isRelationshipWaitAnxietyConcretize =
            (
              /(待つ|待って|待っている|待つという|待つの|待てない).*(不安|しんどい|つらい|辛い|苦しい|増す|増える|大きくなる|耐えられない)/u.test(
                currentUserText,
              ) ||
              /(不安|しんどい|つらい|辛い|苦しい).*(増す|増える|大きくなる|待つ|待って|待てない)/u.test(
                currentUserText,
              )
            ) &&
            /(連絡|彼|彼女|相手|恋愛|返信|返事|待つ|一通|連投|急かさない)/u.test(
              `${currentUserText} ${previousAssistantText}`,
            );

          if (isRelationshipWaitAnxietyConcretize) {
            return [
              'RELATIONSHIP_WAIT_ANXIETY_CONCRETIZE (DO NOT OUTPUT):',
              `CURRENT_USER=${currentUserText}`,
              previousAssistantText ? `PREVIOUS_ASSISTANT=${previousAssistantText.slice(0, 360)}` : '',
              'MODE=待つことで増える不安を、具体的に扱える形へ変換する',
              'RULE=状態観測に戻らない。「待つあいだに不安が前に出る」「重さが残る」などで終わらない',
              'RULE=「待つ」は、何もしないで耐えることではないと説明する',
              'RULE=「待つ」は、一通送ったあとに不安を連投で処理しない時間だと説明する',
              'RULE=不安が増すのは自然だと受ける。ただし不安のまま追加で送ると、確認したい圧が強くなりやすいと説明する',
              'RULE=「返事がない＝嫌われた」と決めず、「今は相手の返せるタイミングを待っている」と読み替える方向を出す',
              'RULE=待つ時間を、見捨てられている時間にしないことを説明する',
              'RULE=追加で送る代わりに、すでに送った一通の役割を思い出す方向へ返す',
              'RULE=ユーザーの状態が「待つしかない」から「待つ時間の扱い方がわかった」に変わるように返す',
              'OUTPUT=普通の会話文で、3〜5段落。番号・見出し・箇条書きにしない',
            ]
              .filter(Boolean)
              .join('\n');
          }

          const previousUserTextForSolution =
            [...historyForWriterSource]
              .reverse()
              .map((m: any) => {
                const role = String(m?.role ?? m?.type ?? '').trim().toLowerCase();
                if (role !== 'user') return '';

                return String(
                  m?.content ??
                    m?.text ??
                    m?.message ??
                    m?.userText ??
                    '',
                )
                  .replace(/\s+/g, ' ')
                  .trim();
              })
              .find(Boolean) ?? '';

          const isRelationshipSolutionConcretize =
          (
            /(解決(?:方法)?がわからない|解決(?:方法)?が分からない|解決.*わからない|解決.*分からない|答え(?:が|を)?(?:ほしい|欲しい|知りたい)|答え(?:的|っぽい|みたい)(?:なの|なもの|もの)?(?:が|を)?(?:ほしい|欲しい|知りたい)|正解(?:が|を)?(?:ほしい|欲しい|知りたい)|どうするのが正解|どうしたら正解|どうすれば正解|どうすればいいかわからない|どうしたらいいかわからない|具体的に|何をすれば|何を送れば|それだとわからない|それだと分からない|意味がわからない|意味が分からない)/u.test(
              currentUserText,
            ) ||
            (
              /(この状況|この場合|この件|それ|これ|今の状態|どうしたら解決|どうすれば解決|解決しますか|どうしたらいい|どうすればいい)/u.test(
                currentUserText,
              ) &&
              /(彼|彼女|相手|恋愛|連絡|返信|返事|不安|距離|沈黙)/u.test(
                previousUserTextForSolution,
              )
            )
          ) &&
            /(連絡|彼|彼女|相手|恋愛|返信|返事|急かさない|そっと|置いておく|待つ|距離|不安|沈黙)/u.test(
              `${currentUserText} ${previousAssistantText} ${previousUserTextForSolution}`,
            );
          if (!isRelationshipSolutionConcretize) return '';

          return [
            'RELATIONSHIP_SOLUTION_CONCRETIZE (DO NOT OUTPUT):',
            `CURRENT_USER=${currentUserText}`,
            previousAssistantText ? `PREVIOUS_ASSISTANT=${previousAssistantText.slice(0, 360)}` : '',
            'MODE=前回の抽象助言を、具体的な一手に変換する',
            'RULE=状態観測に戻らない。「まだ決めきれない」「残っている」「開いたまま」などで終わらない',
            'RULE=「待つ」「置いておく」だけで終わらせない。ユーザーが今できる一通・一手まで落とす',
            'RULE=追いかけたい気持ちを否定せず、でも重く送らせない',
            'RULE=一度だけ送れる短文例を出す。例：「忙しいと思うけど、落ち着いたら連絡もらえたらうれしい」',
            'RULE=送った後は連投しない、という境界まで入れる',
            'RULE=ユーザーの状態が「何もできない」から「一手は打てた」に変わるように返す',
            'OUTPUT=普通の会話文で、2〜4段落。番号・見出し・箇条書きにしない',
          ]
            .filter(Boolean)
            .join('\n');
      })(),
    ]
      .filter(Boolean)
      .join('\n\n')
      .replace(/^[ \t]*@OBS[^\n]*(?:\n|$)/gm, '')
      .replace(/^[ \t]*@SHIFT[^\n]*(?:\n|$)/gm, '')
      .replace(/^[ \t]*@SAFE[^\n]*(?:\n|$)/gm, '')
      .replace(/^[ \t]*@NEXT_HINT[^\n]*(?:\n|$)/gm, '')
      .replace(/(?:^|\n)@DELTA[^\n]*/g, '')

      // FLOW_V2 は SEED の difference / transition 観測に必要なので final pack に残す
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return base;
  })();

  try {
    const packNormFinal = norm(internalPackForWriter);
    const hFinal = packNormFinal.slice(0, 900);

    const flowMatchFinal = packNormFinal.match(
      /FLOW_CONTEXT(?:\s*\(DO NOT OUTPUT\))?:|FLOW_MEANING(?:\s*\(DO NOT OUTPUT\))?:|FLOW_V2(?:\s*\(DO NOT OUTPUT\))?:/
    );

    const flowIdxFinal = flowMatchFinal ? flowMatchFinal.index ?? -1 : -1;
    const flowSnippetFinal =
      flowIdxFinal >= 0
        ? packNormFinal.slice(flowIdxFinal, Math.min(packNormFinal.length, flowIdxFinal + 520))
        : '';

    const hasOpennessFinal =
      /(?:^|\n)OPENNESS(?:\n|$)/.test(packNormFinal) ||
      /tLayerHint=|itOk=/.test(packNormFinal);

    const hasWriterDirectivesFinal =
      /(?:^|\n)WRITER_DIRECTIVES(?:\n|$)/.test(packNormFinal) ||
      /tone=|maxLines=|slotPolicy=|rotationMention=/.test(packNormFinal);

    const hasPatternKeyFinal = /(?:^|\n)pattern_key=/.test(packNormFinal);
    const hasPatternModeFinal = /(?:^|\n)pattern_mode=/.test(packNormFinal);
    const hasPatternBlockOrderFinal = /(?:^|\n)pattern_block_order=/.test(packNormFinal);
    const hasBlockClosingLineFinal = /(?:^|\n)block_closing_line=/.test(packNormFinal);
    const hasWriteConstraint4Final = /(?:^|\n)writeConstraint4=/.test(packNormFinal);
    const hasWriteConstraint5Final = /(?:^|\n)writeConstraint5=/.test(packNormFinal);

    console.log('[IROS/writerCalls][INJECTED_PACK_HEAD_FINAL_RAW]', hFinal);

    console.log(
      '[IROS/writerCalls][INJECTED_PACK_HEAD_FINAL]',
      JSON.stringify({
        traceId: (args as any)?.traceId ?? null,
        conversationId: (args as any)?.conversationId ?? null,
        packLen: packNormFinal.length,
        head: hFinal,
        hasCOORD: /COORD\s*\(DO NOT OUTPUT\)/.test(packNormFinal),
        hasPolarity: /polarity=/.test(packNormFinal),
        hasSA: /sa=/.test(packNormFinal),

        hasITX:
          /itx_step=|itx_reason=/.test(packNormFinal) ||
          /itOk=/.test(packNormFinal),

        hasFuture:
          /future=/.test(packNormFinal) ||
          /futureRandom=/.test(packNormFinal),

        hasStateCues: /STATE_CUES_V3\s*\(DO NOT OUTPUT\)/.test(packNormFinal),

        hasFlowMeaning:
          /(?:^|\n)(?:FLOW_MEANING|FLOW_V2)(?:\s*\(DO NOT OUTPUT\))?:/.test(packNormFinal) ||
          /hook=/.test(packNormFinal) ||
          /tension=/.test(packNormFinal) ||
          /openLoop=/.test(packNormFinal),

        hasMirrorFlowSeed:
          /FLOW_SEED_V1\b/.test(packNormFinal) ||
          /FLOW:\s*\n/.test(packNormFinal),

        hasOpenness: hasOpennessFinal,
        hasWriterDirectives: hasWriterDirectivesFinal,
        hasPatternKeyFinal,
        hasPatternModeFinal,
        hasPatternBlockOrderFinal,
        hasBlockClosingLineFinal,
        hasWriteConstraint4Final,
        hasWriteConstraint5Final,
        flowSnippet: flowSnippetFinal,
        saRhythm: saRhythm || null,
        saTone: saTone || null,
        saBrevity: saBrevity || null,
        itxStep: itxStep ?? null,
        itxReason: itxReason ?? null,
      })
    );
  } catch {}
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

        try {
          const deltaPattern =
            /(?:^|\n)(?:@DELTA\b|FLOW180(?:\s*\(DO NOT OUTPUT\))?:|FLOW_V2(?:\s*\(DO NOT OUTPUT\))?:[\s\S]*?(?:^|\n)delta=|FLOW:\n[\s\S]*?(?:^|\n)delta=)/m;

          const deltaDebug = {
            hasDeltaHint: !!deltaHint,
            deltaHint: deltaHint ?? null,
            internalPackForWriterHasDelta: deltaPattern.test(
              String(internalPackForWriter ?? '')
            ),
            packMsgHasDelta: deltaPattern.test(
              String(packMsg?.content ?? '')
            ),
            internalPackForWriterHead: String(internalPackForWriter ?? '').slice(0, 300),
            packMsgHead: String(packMsg?.content ?? '').slice(0, 300),
          };
          console.log(
            '[IROS/writerCalls][PACK_MSG_DELTA_CHECK]',
            JSON.stringify(deltaDebug),
          );
        } catch {}

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

        // ❌ MEANING_SKELETON は完全停止（SEED主導に統一）
        const systemOneWithMeaning = String(systemOne ?? '').trim();

        const historyMsg =
        String(args.historyText ?? '').trim().length > 0
          ? ({ role: 'assistant', content: String(args.historyText).trim() } as WriterMessage)
          : null;

          let messages: WriterMessage[] = [
            { role: 'system', content: systemOneWithMeaning },
            ...(historyMsg ? [historyMsg] : []),
            ...(packMsg ? [packMsg] : []),
            ...(topicRecallNoEvidenceMsg ? [topicRecallNoEvidenceMsg] : []),
            ...turns,
          ];

          const prefixCount =
            1 +
            (historyMsg ? 1 : 0) +
            (packMsg ? 1 : 0) +
            (topicRecallNoEvidenceMsg ? 1 : 0);

          const prefix = messages.slice(0, prefixCount);
          const tailMessages = messages.slice(prefixCount);

          messages = [...prefix, ...mergeConsecutiveSameRole(tailMessages)];

          const finalUserTextForWriter = (() => {
            const currentUserText = String(args.userText ?? '').replace(/\s+/g, ' ').trim();
            const packText = String(packMsg?.content ?? '');

            const resolvedAskForFinalUser =
              (args as any)?.ctxPack?.resolvedAsk ??
              (args as any)?.meta?.extra?.ctxPack?.resolvedAsk ??
              (args as any)?.userContext?.ctxPack?.resolvedAsk ??
              (args as any)?.userContext?.meta?.extra?.ctxPack?.resolvedAsk ??
              null;

              const resolvedAskTopic = String(
                (resolvedAskForFinalUser as any)?.topic ?? ''
              )
                .replace(/\s+/g, ' ')
                .trim();

              const resolvedAskHistoryHint = String(
                (resolvedAskForFinalUser as any)?.historyHint ?? ''
              )
                .replace(/\s+/g, ' ')
                .trim();

              const resolvedAskReadingMode = String(
                (resolvedAskForFinalUser as any)?.readingMode ??
                  (resolvedAskForFinalUser as any)?.replyMode ??
                  ''
              )
                .replace(/\s+/g, ' ')
                .trim();

              const isPartnerSideResonance =
                String((resolvedAskForFinalUser as any)?.askType ?? '').trim() === 'truth_structure' &&
                resolvedAskReadingMode === 'partner_side_resonance' &&
                resolvedAskTopic.length > 0;

                if (isPartnerSideResonance) {
                  return [
                    resolvedAskTopic,
                    '',
                    ...(resolvedAskHistoryHint
                      ? [
                          '既出文脈:',
                          resolvedAskHistoryHint,
                          '',
                          '既出文脈は必要な場合だけ、本文に一度だけ自然に入れてください。',
                        ]
                      : []),
                    '彼/彼女/相手側の様子を、事実断定ではなく「今こちらにそう映っている可能性」として会話文で返してください。',
                    '相手側だけを読むのではなく、ユーザー側の不安・投影・思い込みがどこに重なっているかも、自然に一文で含めてください。',
                    '解決や「どうしたら」に関わる場合は、最後に今こちらが取る距離感を短く置いてください。',
                    'ただし番号・見出しは避け、自然な2〜3段落で返してください。ユーザーが例を求めた場合のみ、番号ではなく「- 」の箇条書きを独立行で使ってよい。',
                    '彼/彼女/相手の本心や事実を断定しないでください。',
                  ].join('\n');
                }

            const contextFromPack =
              packText.match(/(?:^|\n)CONTEXT:\n([^\n]+)/)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';

            const isResonanceStructureInstruction =
              /共鳴|構造|象徴|響き/u.test(currentUserText) &&
              contextFromPack.length > 0 &&
              contextFromPack !== currentUserText;

            if (!isResonanceStructureInstruction) {
              return currentUserText;
            }

            return [
              contextFromPack,
              '',
              '共鳴構造・象徴構造・関係構造として見てください。',
              'この依頼文そのものは分析せず、対象そのものを見てください。',
            ].join('\n');
          })();

          messages = ensureEndsWithUser(messages, finalUserTextForWriter);

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
      const role = t?.role === 'user' ? 'user' : null;
      if (!role) return null;

      const s0 = norm(String(t?.content ?? t?.text ?? ''));
      const s1 = clampStr(stripInternalMarkersFromUserText(s0), 900);
      if (!s1) return null;

      return { role: 'user', content: s1 } as WriterMessage;
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
  slotDecision?: any;
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

  // ✅ user は通す。assistant は通常 assistant 会話は落とす
  const MAX_USER = 900;
  const MAX_ASSIST_INTERNAL = 3200;
  const MAX_ASSIST_PLAIN = 900;

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
        const a0 = norm(String(m.content ?? ''));

        const isInternalPack =
          /^INTERNAL PACK \(DO NOT OUTPUT\):/i.test(a0) ||
          /^COORD \(DO NOT OUTPUT\):/i.test(a0) ||
          /^HISTORY_LITE \(DO NOT OUTPUT\):/i.test(a0) ||
          /^TOPIC_RECALL_NO_EVIDENCE \(DO NOT OUTPUT\):/i.test(a0) ||
          /^FLOW_V2 \(DO NOT OUTPUT\):/i.test(a0) ||
          /^FLOW180(?:_SEED)? \(DO NOT OUTPUT\):/i.test(a0) ||
          /^DELTA_HINT \(DO NOT OUTPUT\):/i.test(a0) ||
          /^SEED \(DO NOT OUTPUT\):/i.test(a0) ||
          /^WRITER_DIRECTIVES \(DO NOT OUTPUT\):/i.test(a0) ||
          /^PATTERN_OUTPUT_CONTRACT \(DO NOT OUTPUT\):/i.test(a0) ||
          /(?:^|\n)PAST_STATE_RECALL:\s*enabled(?:\n|$)/i.test(a0) ||
          /(?:^|\n)PAST_STATE_NOTE:\s*/i.test(a0);
        const a1 = clampStr(a0, isInternalPack ? MAX_ASSIST_INTERNAL : MAX_ASSIST_PLAIN);
        if (!a1) return null;

        return isInternalPack
          ? ({ role: 'assistant', content: a1 } as WriterMessage)
          : null;
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

  let out = '';

  try {
    out = await chatComplete({
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
  } catch (err: any) {
    const msg = String(err?.message ?? err ?? '');
    const shouldRetry =
      /LLM HTTP 5\d\d/i.test(msg) ||
      /server_error/i.test(msg) ||
      /status:\s*5\d\d/i.test(msg);

    if (!shouldRetry) {
      throw err;
    }

    console.log(
      '[IROS/writerCalls][WRITER_RETRY_ON_5XX]',
      JSON.stringify({
        traceId: args.traceId ?? null,
        conversationId: args.conversationId ?? null,
        userCode: args.userCode ?? null,
        reason: msg.slice(0, 240),
      })
    );

    out = await chatComplete({
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
  }
  const finalText = stripLeadingEcho(out ?? '');
  let text = finalText;

  const recallUsed = Boolean((args as any)?.userContext?.ctxPack?.recallUsed);
  const recallHit = String((args as any)?.userContext?.ctxPack?.recallHit ?? '').trim();
  const userText =
    String(args.echoGuardUserText ?? '') ||
    String((args as any)?.userContext?.rawUserText ?? '') ||
    String((args as any)?.userText ?? '');

  const isExplicitContinuation =
    /この前|続き|前に言ってた|前に|前の話(?:し)?|前の流れ|つなげて|続きとして/.test(userText);

  void recallUsed;
  void recallHit;
  void isExplicitContinuation;

  return text;
}
