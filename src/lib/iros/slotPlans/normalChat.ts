// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flow-first, sofia-aligned)
//
// 設計原則（normalChat）
// - 意味を決めない / 問題を特定しない / 正解を出さない
// - “流れ”だけを壊さない（会話継続が最優先）
// - slotPlan は文章を書かない（ただし LLM 失敗時に UI が死なない seed は置く）
//
// ここは「浅くていい」担当：
// - 確証がないうちは GPT っぽい軽さでOK
// - 旗印は “強くやらない”。説教/誘導/断定/診断を避けるだけ守る

import type { SlotPlanPolicy } from '../server/llmGate';
import { observeFlow } from '../input/flowObserver';

// --------------------------------------------------
// types
// --------------------------------------------------

export type NormalChatSlot = {
  key: string;
  slotId?: string;
  role: 'assistant';
  style: 'neutral' | 'soft';
  content: string; // writer 向けメタ（or seed text）
};

export type NormalChatSlotPlan = {
  kind: 'normal-chat';
  stamp: string;
  reason: string;
  slotPlanPolicy: SlotPlanPolicy;
  slots: NormalChatSlot[];
};

// --------------------------------------------------
// helpers
// --------------------------------------------------

function norm(s: unknown) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clamp(s: string, n: number) {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + '…';
}

function m(tag: string, payload?: Record<string, unknown>) {
  if (!payload || Object.keys(payload).length === 0) return `@${tag}`;
  try {
    return `@${tag} ${JSON.stringify(payload)}`;
  } catch {
    return `@${tag}`;
  }
}

function normalizeSlots(slots: NormalChatSlot[]): NormalChatSlot[] {
  let i = 0;
  return (Array.isArray(slots) ? slots : []).map((s) => ({
    ...s,
    slotId: s.slotId ?? `N${++i}`,
  }));
}

// deterministic tiny hash（ランダム禁止の代わり）
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pick<T>(arr: T[], seed: string): T {
  if (!arr.length) throw new Error('pick: empty');
  const idx = hash32(seed) % arr.length;
  return arr[idx]!;
}

// --------------------------------------------------
// minimal detectors（意味判定はしない）
// --------------------------------------------------

function isEnd(text: string) {
  const t = norm(text);
  return t === 'ここまで' || t === '以上' || t.includes('今日はここまで');
}

function isCompose(text: string) {
  const t = norm(text);
  return /(文章|文面|例文|文を作って|書いて|まとめて)/.test(t);
}

// --------------------------------------------------
// slot builders
// --------------------------------------------------

function buildEmpty(): NormalChatSlot[] {
  return [{ key: 'EMPTY', role: 'assistant', style: 'soft', content: m('EMPTY') }];
}

function buildEnd(): NormalChatSlot[] {
  return [
    { key: 'END', role: 'assistant', style: 'soft', content: m('END') },
    { key: 'NEXT', role: 'assistant', style: 'neutral', content: m('NEXT', { reopen: true }) },
  ];
}

function buildCompose(userText: string): NormalChatSlot[] {
  const t = norm(userText);
  return [
    {
      key: 'TASK',
      role: 'assistant',
      style: 'neutral',
      content: m('TASK', { kind: 'compose', user: clamp(t, 240) }),
    },
    {
      key: 'DRAFT',
      role: 'assistant',
      style: 'soft',
      content: m('DRAFT', {
        rules: {
          no_advice: true,
          no_summary: true,
          no_checklist: true,
          questions_max: 1,
        },
      }),
    },
  ];
}

// LLMが落ちても UI に出せる “自然な seed” を作る
// - 数/時間/形式の強制をしない（「1つだけ」「一行」「5分で」禁止）
// - 「軽くでいい」など曖昧な評価語を使わない
// - 説教/構造語（足場/結論/意味づけ）を使わない
// - 次の出口は「選択権の返却」＋「続けるなら」の前置きで作る（質問0〜1）
function buildSeedText(args: {
  userText: string;
  flowDelta: string;
  lastUserText?: string | null;
}): string {
  const u = norm(args.userText);
  const u60 = clamp(u, 60);

  // 冒頭：毎回の復唱を避ける（引用は時々）
  const openers = [
    `うん、${u60}って感じなんだね。`,
    `了解。いまの話は受け取ったよ。`,
    `いま出てきた言い方、けっこう“本音寄り”だと思う。`,
    `「${u60}」って言葉を選んだところに、手応えが出てる気がする。`,
  ];

  // 本文：意味を決めず、手触りだけ返す（評価語を増やさない）
  const middles_forward = [
    `いまは整理しきらなくていい。どこが進んだ感じか、感触だけ残そう。`,
    `流れは前に動いてる。細部より、動いてる部分を見失わないのが先。`,
    `ここは深掘りより、いまの「進んでる感」を保ったまま続けたい。`,
  ];

  const middles_back = [
    `戻る感じがあっても普通だよ。大事なのは「どこに戻ったか」だけ。`,
    `いまは結論に寄せなくていい。引っかかった地点だけ覚えておけば進む。`,
    `ペースを落としてもOK。雑に片づけない、だけで流れは繋がる。`,
  ];

  const middles_stuck = [
    `詰まってるなら、原因探しは後でいい。まず「止まる場所」だけ見たい。`,
    `いま必要なのは勢いじゃなくて、次に繋がる置き方を見つけること。`,
    `止まり気味でも大丈夫。止まった位置が分かれば会話は続く。`,
  ];

  const delta = String(args.flowDelta || 'FORWARD').toUpperCase();
  const middle =
    delta.includes('BACK') || delta.includes('RETURN')
      ? pick(middles_back, u)
      : delta.includes('STUCK') || delta.includes('STOP') || delta.includes('STALL')
        ? pick(middles_stuck, u)
        : pick(middles_forward, u);

  // 出口：強制しない。続けるなら…で「選択」を返す（質問は0〜1）
  const exits = [
    `いま見えてるのは、「手応えがある所」と「引っかかる所」、そのどちらかっぽい。`,
    `この流れだと、話しやすいのはどの辺か、自然に分かれそう。`,
    `いま頭に残ってるのは、進んだ感じの所？それとも止まった感じの所？`,
    `話の向きとしては、設計寄りか、実装寄りか、その辺に寄っていきそう。`,
    `ここから先は、進んでる部分を見るか、引っかかった所を見るか、分岐がありそう。`,
    `いま触るとしたら、いちばん違和感が少なそうなのはどの辺？`,
    `この話、次に広がるとしたら、前に進んだ所か、立ち止まった所かになりそう。`,
    `全体を見ると、手応えの話と引っかかりの話、そのどちらかが残ってそう。`,
  ];

  const opener = pick(openers, u + '|' + (args.lastUserText ?? ''));
  const exit = pick(exits, u + '|' + delta);

  // 3行。短すぎず、でも押し付けない。
  return [opener, middle, exit].join('\n');
}


function buildFlowReply(
  userText: string,
  flow: { delta: string; confidence?: number } | null,
  lastUserText?: string | null
): NormalChatSlot[] {
  const t = norm(userText);
  const delta = flow?.delta ? String(flow.delta) : 'FORWARD';
  const conf = typeof flow?.confidence === 'number' ? flow!.confidence : undefined;

  const seedText = buildSeedText({
    userText: t,
    flowDelta: delta,
    lastUserText,
  });

  return [
    // ✅ LLM が落ちたときも UI が “普通の会話” で持つための seed（固定テンプレは禁止）
    { key: 'SEED_TEXT', role: 'assistant', style: 'soft', content: seedText },

    // ✅ writer向けメタ（意味決定はしない）
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        user: clamp(t, 200),
        flow: delta,
        conf,
      }),
    },

    // ✅ normalChat は “会話継続” なので質問は 0〜1（0固定にしない）
    // ただし writer は「質問逃げ（教えて/詳しく）」を避け、選択肢/一行依頼で出口を作る
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'light_chat',
        questions_max: 1,
        avoid: ['advice', 'diagnosis', 'lecture', 'generic_cheer', 'hedge_many'],
      }),
    },
  ];
}

// --------------------------------------------------
// main
// --------------------------------------------------

export function buildNormalChatSlotPlan(args: {
  userText: string;
  context?: {
    recentUserTexts?: string[];
    lastSummary?: string | null; // orchestrator互換（ここでは使わない）
  };
}): NormalChatSlotPlan {
  const stamp = 'normalChat@light-gptlike-v1';
  const userText = norm(args.userText);

  const recentRaw = Array.isArray(args.context?.recentUserTexts) ? args.context!.recentUserTexts! : [];
  const recent = recentRaw.map((x) => norm(x)).filter(Boolean);
  const lastUserText = recent.length > 0 ? recent[recent.length - 1] : null;

  let flow: { delta: string; confidence?: number } | null = null;
  try {
    flow = observeFlow({
      currentText: userText,
      lastUserText: lastUserText ?? undefined,
    }) as any;
  } catch {
    flow = { delta: 'FORWARD' };
  }

  let reason = 'flow';
  let slots: NormalChatSlot[] = [];

  if (!userText) {
    reason = 'empty';
    slots = buildEmpty();
  } else if (isEnd(userText)) {
    reason = 'end';
    slots = buildEnd();
  } else if (isCompose(userText)) {
    reason = 'compose';
    slots = buildCompose(userText);
  } else {
    const d = flow?.delta ? String(flow.delta) : 'FORWARD';
    reason = `flow:${d}`;
    slots = buildFlowReply(userText, flow, lastUserText);
  }

  return {
    kind: 'normal-chat',
    stamp,
    reason,

    // ✅ normalChat は “浅くていい” ので基本は UNKNOWN（強制LLMにしない）
    // - compose / end だけ FINAL（完成文 or 終了が必要）
    slotPlanPolicy: reason === 'compose' || reason === 'end' ? 'FINAL' : 'UNKNOWN',

    slots: normalizeSlots(slots),
  };
}
