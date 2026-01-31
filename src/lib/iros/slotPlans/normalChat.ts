// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flow-first, sofia-aligned)
//
// ✅ 新憲法（今回の全文修正）
// - slotPlan は「本文（自然文）」を絶対に書かない（= seed文がUIに出ない）
// - slotPlan は @OBS/@SHIFT など “内部マーカーのみ” を生成し、LLM writer に本文を作らせる
// - ランダムは許可：偶然の気付きのために「内部ヒントの揺らぎ」にのみ使う（本文はLLM）
// - 意味を決めない / 誘導しない / 断定しない。ただし「質問への返答」は許可する
//
// 重要：postprocess は slotText を cleaned して commit する。
// - @行だけ → cleanedSlotText が空 → commitされず writer が本文生成
// - 自然文が混ざる → commitされる（seed露出）
//  لذلك：このファイルは「@行のみ」に固定する。

import type { SlotPlanPolicy } from '../server/llmGate';
import { observeFlow } from '../input/flowObserver';

// ✅ 追加：HowTo/方法質問を「立ち位置」へ変換する slots
import { shouldUseQuestionSlots, buildQuestionSlots } from './QuestionSlots';

// --------------------------------------------------
// types
// --------------------------------------------------

export type NormalChatSlot = {
  key: string;
  slotId?: string;
  role: 'assistant';
  style: 'neutral' | 'soft' | 'friendly';
  content: string; // ✅ 必ず @TAG 形式（自然文禁止）
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
  // ✅ content は必ず @ で始める（postprocess が @行を落とす）
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

// ✅ ランダム許可（偶然の気付き用途：内部ヒントの揺らぎにだけ使う）
function pickRandom<T>(arr: T[]): T {
  if (!arr.length) throw new Error('pickRandom: empty');
  const idx = Math.floor(Math.random() * arr.length);
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

// ✅ 確認・ツッコミ・意味質問（会話の噛み合わせ優先）
function isClarify(text: string) {
  const t = norm(text);
  if (!t) return false;

  if (
    /^(何が|なにが|どこが|どれが|それって|それは|どういう意味|つまり|具体的に|なぜ|なんで|何で)\b/.test(
      t,
    )
  ) {
    return true;
  }

  if (/(って何|とは|意味|何を出す|何を言えば|何のこと|強いの|でしょ|なの)/.test(t)) {
    return true;
  }

  // 記号疑問（？/?) も拾う（短文の噛み合わせに効く）
  if (/[?？]/.test(t) && t.length <= 40) return true;

  return false;
}

// --------------------------------------------------
// slot builders（自然文禁止：@行だけ）
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

// ✅ clarify：テンプレ自然文を出さない。LLMに “意味に答える” を許可するだけ。
function buildClarify(userText: string): NormalChatSlot[] {
  const t = norm(userText);

  const contracts = [
    [
      'first_line_must_answer_question_directly',
      'no_question_back_as_first_line',
      'plain_words',
      'no_flow_lecture',
    ],
    [
      'answer_in_one_shot',
      'first_line_is_definition_or_pointing',
      'no_meta_explain',
      'plain_words',
    ],
    [
      'first_line_is_yes_no_or_core',
      'then_short_reason',
      'no_boilerplate',
      'plain_words',
    ],
  ];

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', { user: clamp(t, 240), kind: 'clarify', intent: 'answer_the_question' }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'semantic_answer',
        output_contract: pickRandom(contracts),
        forbid: ['diagnosis', 'preach', 'hard_guidance', 'forced_task'],
        questions_max: 1,
      }),
    },
  ];
}

// ✅ HowTo/方法質問（QuestionSlots）を normalChat に合わせて「@行だけ」に正規化
function buildQuestion(userText: string, contextText?: string): NormalChatSlot[] {
  const slots = buildQuestionSlots({ userText, contextText });

  return slots.map((s) => {
    const raw = String((s as any)?.content ?? '');
    // QuestionSlots 側が自然文を返しても、ここで必ず @ 化して本文commitを防ぐ
    const payload = {
      key: String((s as any)?.key ?? 'Q'),
      style: String((s as any)?.style ?? 'neutral'),
      content: clamp(norm(raw), 400),
    };
    return {
      key: String((s as any)?.key ?? 'Q'),
      role: 'assistant',
      style: ((s as any)?.style ?? 'neutral') as any,
      content: m('Q_SLOT', payload),
    };
  });
}

// ✅ normalChat の通常フロー：意味にあった返答を最優先で書かせる（本文はLLM）
function buildFlowReply(
  userText: string,
  flow: { delta: string; confidence?: number } | null,
  lastUserText?: string | null,
): NormalChatSlot[] {
  const t = norm(userText);
  const delta = flow?.delta ? String(flow.delta) : 'FORWARD';
  const conf = typeof flow?.confidence === 'number' ? flow!.confidence : undefined;

  const shiftVariants = [
    {
      kind: 'meaning_first',
      rules: {
        answer_user_meaning: true,
        avoid_template_praise: true,
        avoid_meta_flow_talk: true,
        avoid_generic_cheer: true,
        questions_max: 1,
      },
      allow: { concrete_reply: true, short_reply_ok: true },
    },
    {
      kind: 'meaning_first',
      rules: {
        answer_user_meaning: true,
        no_lecture: true,
        no_checklist: true,
        questions_max: 1,
      },
      allow: { concrete_reply: true, short_reply_ok: true },
    },
    {
      kind: 'meaning_first',
      rules: {
        answer_user_meaning: true,
        keep_it_simple: true,
        questions_max: 1,
      },
      allow: { concrete_reply: true, short_reply_ok: true },
    },
  ];

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        user: clamp(t, 240),
        flow: { delta, confidence: conf },
        lastUserText: lastUserText ? clamp(norm(lastUserText), 140) : null,
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', pickRandom(shiftVariants)),
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
  const stamp = 'normalChat@no-seed-text+random-hints+questionSlots';
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
  } else if (shouldUseQuestionSlots(userText)) {
    reason = 'questionSlots';
    slots = buildQuestion(userText, lastUserText ?? undefined);
  } else if (isClarify(userText)) {
    reason = 'clarify';
    slots = buildClarify(userText);
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

    // ✅ empty だけ UNKNOWN（何も返さない/出せないを許す）
    // ✅ それ以外は FINAL（LLMで本文を作る）
    slotPlanPolicy: reason === 'empty' ? 'UNKNOWN' : 'FINAL',

    slots: normalizeSlots(slots),
  };
}
