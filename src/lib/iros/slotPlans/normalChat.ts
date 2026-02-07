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

// ✅ Phase11: advance判定のための “橋” を必ず出す
// - evidenceLog.ts は key==='NEXT' または content.startsWith('@NEXT_HINT') を検出し、
//   さらに mode==='advance_hint' を拾えれば advance=1 になる。
function buildNextHintSlot(args: { userText: string; laneKey?: LaneKey; flowDelta?: string | null }): NormalChatSlot {
  const laneKey = safeLaneKey(args.laneKey);
  const delta = args.flowDelta ? String(args.flowDelta) : null;

  // ⚠️ advance 判定専用：
  // - userText は seed に入れない（重複注入＝同文エコー防止）
  // - 意味生成は SHIFT / TASK / Q_SLOT 側の seed_text に一任する
  const hint =
    laneKey === 'T_CONCRETIZE'
      ? '次の一手を1つに絞って実行'
      : '候補を2〜3に並べて選びやすくする';

  return {
    key: 'NEXT',
    role: 'assistant',
    style: 'neutral',
    content: `@NEXT_HINT ${JSON.stringify({
      mode: 'advance_hint',
      laneKey,
      delta,
      hint: clamp(hint, 80),
      // seed_text intentionally omitted
    })}`,
  };
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

function buildCompose(userText: string, laneKey?: LaneKey, flowDelta?: string | null): NormalChatSlot[] {
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

    // ✅ Phase11 advance測定用の橋
    buildNextHintSlot({ userText, laneKey, flowDelta }),
  ];
}

// ✅ clarify：テンプレ自然文を出さない。LLMに “意味に答える” を許可するだけ。
function buildClarify(userText: string, laneKey?: LaneKey, flowDelta?: string | null): NormalChatSlot[] {
  const isT = laneKey === 'T_CONCRETIZE';

  const contractsClarify = [
    ['first_line_must_answer_question_directly', 'no_question_back_as_first_line', 'plain_words', 'no_flow_lecture'],
    ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'no_meta_explain', 'plain_words'],
    ['first_line_is_yes_no_or_core', 'then_short_reason', 'no_boilerplate', 'plain_words'],
  ];

  // ✅ T_CONCRETIZE 用：契約は「コア→10分→反復条件」を強制する寄せ方にする
  const contractsT = [
    ['first_line_is_core', 'no_user_echo', 'one_next_step', 'no_lecture', 'plain_words'],
    ['first_line_is_core', 'then_action_in_10min', 'no_checklist', 'plain_words'],
  ];

  const shiftPreset = isT ? SHIFT_PRESET_T_CONCRETIZE : null;

  return [
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: isT ? 't_concretize' : 'clarify',
        intent: isT ? 'implement_next_step' : 'answer_the_question',
        contract: pickRandom(isT ? contractsT : contractsClarify),

        // ✅ ここが肝：Tのとき preset.rules を丸ごと渡す（focus/10min/repeat を writer に伝える）
        rules: {
          ...(shiftPreset?.rules ?? {}),
          answer_user_meaning: true,
          keep_it_simple: true,
          questions_max: isT ? 0 : 1,
        },

        // ✅ ここも肝：Tのとき preset.allow を優先（short_reply_ok=false を確実に反映）
        allow: {
          ...(shiftPreset?.allow ?? {}),
          concrete_reply: true,
          short_reply_ok: isT ? false : true,
        },

        // ✅ writer専用の“核”（@payload内なので露出しない）
        seed_text: clamp(norm(userText), 240),
      }),
    },

    // ✅ Phase11 advance測定用の橋（clarifyでも必ず出す）
    buildNextHintSlot({ userText, laneKey, flowDelta }),
  ];
}


// ✅ HowTo/方法質問（QuestionSlots）を normalChat に合わせて「@行だけ」に正規化
function buildQuestion(
  userText: string,
  contextText?: string,
  laneKey?: LaneKey,
  flowDelta?: string | null
): NormalChatSlot[] {
  const slots = buildQuestionSlots({ userText, contextText, laneKey });

  const seedText = clamp(norm(userText), 240);
  const ctxText = contextText ? clamp(norm(contextText), 240) : null;

  const mapped: NormalChatSlot[] = slots.map((s) => {
    const raw = String((s as any)?.content ?? '');

    const payload: Record<string, unknown> = {
      key: String((s as any)?.key ?? 'Q'),
      style: String((s as any)?.style ?? 'neutral'),
      content: clamp(norm(raw), 400),

      // ✅ writer seed 用（@payloadの中）
      seed_text: seedText,
      context_text: ctxText,
    };

    const style =
      (String((s as any)?.style ?? 'neutral') as NormalChatSlot['style']) ||
      'neutral';

    const out: NormalChatSlot = {
      key: String((s as any)?.key ?? 'Q'),
      role: 'assistant', // ✅ リテラル固定（string widen防止）
      style,
      content: m('Q_SLOT', payload),
    };

    return out;
  });

  // 🚑 T_CONCRETIZE で QuestionSlots が空の場合は、必ず具体化SHIFTを補填
  if (laneKey === 'T_CONCRETIZE' && mapped.length === 0) {
    mapped.push({
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        text: buildShiftTConcretize(seedText),
      }),

    });
  }

  return mapped;
}



// --------------------------------------------------
// Lane-specific SHIFT builders（自然文禁止）
// - ルールは shiftPresets に寄せる
// --------------------------------------------------

function buildShiftIdeaBand(seedText: string) {
  const variants = [
    {
      // 候補生成（核なし）— 候補は「列挙OK」にする（no_checklist を解除）
      kind: 'idea_band',
      intent: 'propose_candidates',
      rules: {
        ...SHIFT_PRESET_C_SENSE_HINT.rules,

        // ✅ IDEA_BAND では「候補を並べる」こと自体が目的なので、列挙禁止を解除
        no_checklist: false,

        // 既定の方針
        no_decision: true,
        no_action_commit: true,

        // 候補数
        candidates_min: 2,
        candidates_max: 4,

        // 文章が1行に潰れないように上限も明示（writer契約）
        lines_max: 4,

        // 質問で進めない（提示で進める）
        questions_max: 1,
      },
      tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,
      allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), short_reply_ok: true },
      format: {
        // ✅ “候補行” を強制（箇条書きでもOKなスキーマ）
        lines: 3,
        schema: ['frame(one_line)', 'candidates(2-4_lines)', 'close(one_line_optional)'],
      },
    },
  ];

  const picked = pickRandom(variants);
  return m('SHIFT', {
    ...picked,
    seed_text: clamp(seedText, 240),
  });
}

// --- 置き換え 1) buildShiftTConcretize を関数まるごと置き換え ---
function buildShiftTConcretize(seedText: string, focusLabel?: string) {
  // ✅ t_concretize は「行動」ではなく「対象」に1点フォーカスする
  // - 時間指定（<=10min）/ タイマー/ やり方指示は禁止
  // - 1点の正体は "target label"（focusLabel）
  const payload: any = {
    kind: 't_concretize',
    intent: 'implement_next_step',

    // preset: T具体化の禁則はここに寄せる
    rules: {
      ...(SHIFT_PRESET_T_CONCRETIZE.rules ?? {}),
      questions_max: 1,
      no_checklist: true,
      keep_small: true,
      repeatable: true,
      // ✅ 時間・姿勢・手順テンプレは契約に含めない
    },

    tone: SHIFT_PRESET_T_CONCRETIZE.tone ?? undefined,
    allow: SHIFT_PRESET_T_CONCRETIZE.allow ?? { concrete_reply: true, short_reply_ok: true },

    // ✅ writer契約：対象ラベル中心（行動・時間なし）
    format: {
      lines: 3,
      schema: [
        'focus_label(target_one_phrase_optional)',
        'core(core_short_one_line)',
        'close(one_line_optional)',
      ],
    },

    seed_text: clamp(seedText, 240),
  };

  // ✅ 上流が渡してきたときだけ採用（writerが推定しない）
  if (typeof focusLabel === 'string' && focusLabel.trim().length > 0) {
    payload.focusLabel = clamp(norm(focusLabel), 80);
  }

  return m('SHIFT', payload);
}

// --- 置き換え 2) buildFlowReply を関数まるごと置き換え ---
function buildFlowReply(args: {
  userText: string;
  laneKey: LaneKey;
  flow: { delta: string; confidence?: number } | null;
  lastUserText?: string | null;

  // ✅ A案：上流が「いま触る1点（対象）」を渡せる差し込み口
  focusLabel?: string;
}): NormalChatSlot[] {
  const t = norm(args.userText);
  const laneKey = safeLaneKey(args.laneKey);

  const delta = args.flow?.delta ? String(args.flow.delta) : 'FORWARD';
  const conf = typeof args.flow?.confidence === 'number' ? args.flow!.confidence : undefined;

  const seedText = clamp(t, 240);

  const shift =
    laneKey === 'T_CONCRETIZE'
      ? buildShiftTConcretize(seedText, args.focusLabel)
      : buildShiftIdeaBand(seedText);

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

    // ✅ Phase11 advance測定用の橋（通常フローでも必ず出す）
    buildNextHintSlot({ userText: t, laneKey, flowDelta: delta }),
  ];
}

// --- 置き換え 3) buildNormalChatSlotPlan の args 型だけ差し替え ---
// 既存の export function buildNormalChatSlotPlan(args: { ... }) の「引数型」に、focusLabel を追加してください。
// （関数本体はそのまま）
export function buildNormalChatSlotPlan(args: {
  userText: string;

  // ✅ 上流（orchestrator/postprocess）が決めたレーンを受け取る
  // 未指定でも壊れない（保守的に IDEA_BAND）
  laneKey?: LaneKey;

  // ✅ A案：上流が「対象ラベル（いま触る1点）」を渡せる
  // - 例: "MIN_OK_LEN 周り" / "OK_TOO_SHORT_TO_RETRY の条件" など
  focusLabel?: string;

  context?: {
    recentUserTexts?: string[];
    lastSummary?: string | null; // orchestrator互換（ここでは使わない）
  };
}): NormalChatSlotPlan {
  // （この下の既存の関数本体は変更しない）
  // ...

  const laneKey = safeLaneKey(args.laneKey);

  const stamp = `normalChat@lane:${laneKey}@no-seed-text+random-hints+questionSlots+nextHint`;
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

  const flowDelta = flow?.delta ? String(flow.delta) : null;

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
    slots = buildQuestion(userText, lastUserText ?? undefined, laneKey, flowDelta);
  } else if (isClarify(userText)) {
    reason = 'clarify';
    slots = buildClarify(userText, laneKey, flowDelta);
  } else if (isCompose(userText)) {
    reason = 'compose';
    slots = buildCompose(userText, laneKey, flowDelta);
  } else {
    const d = flow?.delta ? String(flow.delta) : 'FORWARD';
    reason = `flow:${d}`;
    slots = buildFlowReply({ userText, laneKey, flow, lastUserText, focusLabel: args.focusLabel });
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
