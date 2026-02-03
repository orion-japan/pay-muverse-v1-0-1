// src/lib/iros/slotPlans/normalChat.ts
// iros — normal chat slot plan (FINAL-only, flow-first, sofia-aligned)
//
// ✅ 新憲法（全文整理）
// - slotPlan は「本文（自然文）」を絶対に書かない（= seed文がUIに出ない）
// - slotPlan は @OBS/@SHIFT など “内部マーカーのみ” を生成し、LLM writer に本文を作らせる
// - ランダムは許可：偶然の気付きのために「内部ヒントの揺らぎ」にのみ使う（本文はLLM）
// - 意味を決めない / 誘導しない / 断定しない。ただし「質問への返答」は許可する
//
// 重要：postprocess は slotText を cleaned して commit する。
// - @行だけ → cleanedSlotText が空 → commitされず writer が本文生成
// - 自然文が混ざる → commitされる（seed露出）
// よって：このファイルは「@行のみ」に固定する。
//
// ✅ レーン（目的）を導入（IntentBridgeが上流で確定）
// - IDEA_BAND: R→I 候補生成（核なし）
// - T_CONCRETIZE: I→C→T 具体化（核あり/宣言あり）
// ※ normalChat は両方レーンを扱う（ただし“強度/テンプレ”はレーンで分ける）

import type { SlotPlanPolicy } from '../server/llmGate';
import { observeFlow } from '../input/flowObserver';

// ✅ 追加：HowTo/方法質問を「立ち位置」へ変換する slots
import { shouldUseQuestionSlots, buildQuestionSlots } from './QuestionSlots';

// ✅ レーン型（IntentBridgeと同じ定義を使う）
import type { LaneKey } from '../intentTransition/intentBridge';

// ✅ SHIFT preset（ルールをここに寄せる）
import { SHIFT_PRESET_C_SENSE_HINT, SHIFT_PRESET_T_CONCRETIZE } from '../language/shiftPresets';

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

function safeLaneKey(v: unknown): LaneKey {
  return v === 'T_CONCRETIZE' ? 'T_CONCRETIZE' : 'IDEA_BAND';
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

  if (/^(何が|なにが|どこが|どれが|それって|それは|どういう意味|つまり|具体的に|なぜ|なんで|何で)\b/.test(t)) {
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
      content: m('TASK', {
        kind: 'compose',
        user: clamp(t, 240),

        // ✅ writer専用の“核”をpayloadに埋める（自然文は混ぜない＝commit露出しない）
        seed_text: clamp(t, 240),
      }),
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
  const contracts = [
    [
      'first_line_must_answer_question_directly',
      'no_question_back_as_first_line',
      'plain_words',
      'no_flow_lecture',
    ],
    ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'no_meta_explain', 'plain_words'],
    ['first_line_is_yes_no_or_core', 'then_short_reason', 'no_boilerplate', 'plain_words'],
  ];

  return [
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: 'clarify',
        intent: 'answer_the_question',
        contract: pickRandom(contracts),
        rules: {
          answer_user_meaning: true,
          keep_it_simple: true,
          questions_max: 1,
        },
        allow: { concrete_reply: true, short_reply_ok: true },

        // ✅ writer専用の“核”（@payload内なので露出しない）
        seed_text: clamp(norm(userText), 240),
      }),
    },
  ];
}

// ✅ HowTo/方法質問（QuestionSlots）を normalChat に合わせて「@行だけ」に正規化
function buildQuestion(userText: string, contextText?: string): NormalChatSlot[] {
  const slots = buildQuestionSlots({ userText, contextText });

  const seedText = clamp(norm(userText), 240);
  const ctxText = contextText ? clamp(norm(contextText), 240) : null;

  return slots.map((s) => {
    const raw = String((s as any)?.content ?? '');

    const payload: Record<string, unknown> = {
      key: String((s as any)?.key ?? 'Q'),
      style: String((s as any)?.style ?? 'neutral'),
      content: clamp(norm(raw), 400),

      // ✅ writer seed 用（@payloadの中）
      seed_text: seedText,
      context_text: ctxText,
    };

    return {
      key: String((s as any)?.key ?? 'Q'),
      role: 'assistant',
      style: ((s as any)?.style ?? 'neutral') as any,
      content: m('Q_SLOT', payload),
    };
  });
}

// --------------------------------------------------
// Lane-specific SHIFT builders（自然文禁止）
// - ルールは shiftPresets に寄せる
// --------------------------------------------------

function buildShiftIdeaBand(seedText: string) {
  const variants = [
    {
      // 候補生成（核なし）
      kind: 'idea_band',
      intent: 'propose_candidates',
      rules: {
        ...SHIFT_PRESET_C_SENSE_HINT.rules,
        no_decision: true,
        no_action_commit: true,
        candidates_min: 2,
        candidates_max: 4,
      },
      tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,
      allow: SHIFT_PRESET_C_SENSE_HINT.allow ?? undefined,
    },
    {
      kind: 'idea_band',
      intent: 'propose_candidates',
      rules: {
        ...SHIFT_PRESET_C_SENSE_HINT.rules,
        no_decision: true,
        no_action_commit: true,
        candidates_min: 2,
        candidates_max: 4,
      },
      tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,
      allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), concrete_reply: true, short_reply_ok: true },
    },
  ];

  const picked = pickRandom(variants);
  return m('SHIFT', {
    ...picked,
    seed_text: clamp(seedText, 240),
  });
}

function buildShiftTConcretize(seedText: string) {
  // ✅ 3行固定テンプレ（核→次の一手→反復条件）
  // ※自然文は書かない。writer に“形式”を強制する。
  return m('SHIFT', {
    kind: 't_concretize',
    intent: 'implement_next_step',
    // preset: T具体化の禁則はここに寄せる
    rules: {
      ...(SHIFT_PRESET_T_CONCRETIZE.rules ?? {}),
      questions_max: 0,
      no_checklist: true,
      keep_small: true,
      repeatable: true,
    },
    tone: SHIFT_PRESET_T_CONCRETIZE.tone ?? undefined,
    allow: SHIFT_PRESET_T_CONCRETIZE.allow ?? { concrete_reply: true, short_reply_ok: true },
    format: {
      lines: 3,
      schema: ['focus(core_short)', 'next_step(<=10min)', 'repeat_condition(proof_of_stick)'],
    },
    seed_text: clamp(seedText, 240),
  });
}

// ✅ normalChat の通常フロー：レーンに応じて SHIFT を切り替える（本文はLLM）
function buildFlowReply(args: {
  userText: string;
  laneKey: LaneKey;
  flow: { delta: string; confidence?: number } | null;
  lastUserText?: string | null;
}): NormalChatSlot[] {
  const t = norm(args.userText);
  const laneKey = safeLaneKey(args.laneKey);

  const delta = args.flow?.delta ? String(args.flow.delta) : 'FORWARD';
  const conf = typeof args.flow?.confidence === 'number' ? args.flow!.confidence : undefined;

  const seedText = clamp(t, 240);
  const shift = laneKey === 'T_CONCRETIZE' ? buildShiftTConcretize(seedText) : buildShiftIdeaBand(seedText);

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        laneKey,
        user: clamp(t, 240),
        flow: { delta, confidence: conf },
        lastUserText: args.lastUserText ? clamp(norm(args.lastUserText), 140) : null,
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: shift,
    },
  ];
}

// --------------------------------------------------
// main
// --------------------------------------------------

export function buildNormalChatSlotPlan(args: {
  userText: string;

  // ✅ 上流（orchestrator/postprocess）が決めたレーンを受け取る
  // 未指定でも壊れない（保守的に IDEA_BAND）
  laneKey?: LaneKey;

  context?: {
    recentUserTexts?: string[];
    lastSummary?: string | null; // orchestrator互換（ここでは使わない）
  };
}): NormalChatSlotPlan {
  const laneKey = safeLaneKey(args.laneKey);

  const stamp = `normalChat@lane:${laneKey}@no-seed-text+random-hints+questionSlots`;
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
    slots = buildFlowReply({ userText, laneKey, flow, lastUserText });
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
