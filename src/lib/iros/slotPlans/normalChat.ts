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
//
// =========================================================
// ✅ IDEA_BAND 出力契約（仕様固定 / writer 迷い防止）
// 目的：IDEA_BAND は「候補列挙」以外を出さない（GROUND吸い込み事故を止める）
//
// ※契約の“正本”は buildShiftIdeaBand() 直上のコメントに置く（重複させない）
// - ここ（ファイル冒頭）は概要のみ保持する
// - 具体（行数/禁止事項/例示）は buildShiftIdeaBand() を参照
// =========================================================



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

function normalizeLaneKeyOrNull(v: unknown): LaneKey | null {
  return v === 'IDEA_BAND' || v === 'T_CONCRETIZE' ? v : null;
}

// ✅ Phase11: advance判定のための “橋” を必ず出す
// - evidenceLog.ts は key==='NEXT' または content.startsWith('@NEXT_HINT') を検出し、
//   さらに mode==='advance_hint' を拾えれば advance=1 になる。
function buildNextHintSlot(args: { userText: string; laneKey?: LaneKey | null; flowDelta?: string | null }): NormalChatSlot {
  const laneKey = safeLaneKey(args.laneKey); // LaneKey | null
  const delta = args.flowDelta ? String(args.flowDelta) : null;

  const hint =
    laneKey === 'T_CONCRETIZE'
      ? '次の一手を1つに絞って実行'
      : laneKey === 'IDEA_BAND'
        ? '候補を2〜3に並べて選びやすくする'
        : '続けてください';

  return {
    key: 'NEXT',
    role: 'assistant',
    style: 'neutral',
    content: `@NEXT_HINT ${JSON.stringify({
      mode: 'advance_hint',
      laneKey: laneKey ?? null,
      delta,
      hint: clamp(hint, 80),
    })}`,
  };
}
function buildSafeSlot(args: { reason?: string | null; laneKey?: LaneKey | null; flowDelta?: string | null }): NormalChatSlot {
  const laneKey = safeLaneKey(args.laneKey);
  const delta = args.flowDelta ? String(args.flowDelta) : null;

  return {
    key: 'SAFE',
    role: 'assistant',
    style: 'soft',
    content: m('SAFE', {
      laneKey: laneKey ?? null,
      delta,
      reason: args.reason ? clamp(norm(args.reason), 120) : null,
    }),
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
        // 🚫 user キー禁止（生文混入の温床）
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
    buildNextHintSlot({ userText, laneKey: laneKey ?? undefined, flowDelta })

  ];
}

function buildClarify(
  userText: string,
  laneKey?: LaneKey,
  flowDelta?: string | null,
  flow?: { delta?: string; confidence?: number; returnStreak?: number } | null
): NormalChatSlot[] {
  const lane = laneKey;
  const isT = lane === 'T_CONCRETIZE';

  const contractsClarify = [
    ['first_line_must_answer_question_directly', 'no_question_back_as_first_line', 'plain_words', 'no_flow_lecture'],
    ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'no_meta_explain', 'plain_words'],
    ['first_line_is_yes_no_or_core', 'then_short_reason', 'no_boilerplate', 'plain_words'],
  ];

  const contractsT = [
    ['first_line_is_core', 'no_user_echo', 'one_next_step', 'no_lecture', 'plain_words'],
    ['first_line_is_core', 'then_action_in_10min', 'no_checklist', 'plain_words'],
  ];

  const seedText = clamp(norm(userText), 240);
  const delta = flowDelta ? String(flowDelta) : null;
  const conf = typeof flow?.confidence === 'number' ? flow.confidence : undefined;

  const buildClarifyMeaningV1 = (text: string): { kind: 'define' | 'reframe' | 'structure'; line: string; source: string } => {
    const t = norm(text);

    if (/(刺さるSHIFT|刺さるシフト)/i.test(t)) {
      return {
        kind: 'define',
        line: '刺さるSHIFTは、「頑張る」に変えることではなく「その向きなら動ける」に変わる切り替え',
        source: 'question_term',
      };
    }

    if (/(SHIFTって何|シフトって何|shiftとは|シフトとは)/i.test(t)) {
      return {
        kind: 'define',
        line: 'SHIFTは、状況を変える前に「見え方」や「力の通し方」を一段ずらすこと',
        source: 'question_term',
      };
    }

    if (/(なんで.*動けない|なぜ.*動けない|どうして.*動けない)/.test(t)) {
      return {
        kind: 'reframe',
        line: '動けないのは意志が弱いからではなく、まだ抵抗の小さい向きが見つかっていない状態',
        source: 'question_pattern',
      };
    }

    if (/(どうすれば|どうしたら|何から|なにから)/.test(t)) {
      return {
        kind: 'structure',
        line: 'いま必要なのは答えを増やすことより、最初の一歩が通る角度を絞ること',
        source: 'question_pattern',
      };
    }

    if (/(って何|とは|どういう意味|意味)/.test(t)) {
      return {
        kind: 'define',
        line: 'ここで聞かれているのは言葉の説明だけでなく、実際にどう働くかの芯',
        source: 'question_pattern',
      };
    }

    return {
      kind: 'reframe',
      line: '表面の言い換えではなく、その人の中で実際に向きが変わる一点をつかむ話',
      source: 'fallback',
    };
  };

  const clarifyMeaning = buildClarifyMeaningV1(seedText);
  const isDefinitionQuestion =
    /(って何|とは|どういう意味|意味|何ですか|なんですか)/.test(seedText) ||
    /(刺さるSHIFT|刺さるシフト|SHIFTって何|シフトって何)/i.test(seedText);

  const obs: NormalChatSlot = {
    key: 'OBS',
    role: 'assistant',
    style: 'soft',
    content: m('OBS', {
      laneKey: lane ?? null,
      flow: conf === undefined ? { delta } : { delta, confidence: conf },
      user: null,
      lastUserText: null,
    }),
  };

  const safe: NormalChatSlot = {
    key: 'SAFE',
    role: 'assistant',
    style: 'soft',
    content: m('SAFE', {
      laneKey: lane ?? null,
      flow: conf === undefined ? { delta } : { delta, confidence: conf },
    }),
  };

  if (lane === 'IDEA_BAND') {
    return [
      obs,
      {
        key: 'SHIFT',
        role: 'assistant',
        style: 'neutral',
        content: buildShiftIdeaBand(seedText),
      },
      safe,
      buildNextHintSlot({ userText, laneKey: lane, flowDelta: delta }),
    ];
  }

  const shiftPreset = isT ? SHIFT_PRESET_T_CONCRETIZE : null;

  const deepReadBoost =
    String(flow?.delta ?? flowDelta ?? '').toUpperCase() === 'RETURN' &&
    Number((flow as any)?.returnStreak ?? 0) >= 2;

  return [
    obs,
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: m('SHIFT', {
        kind: isT ? 't_concretize' : 'clarify',
        intent: isT ? 'implement_next_step' : 'answer_user_meaning',
        hint: isT ? 'clarify_t_concretize_v1' : 'clarify_meaning_v1',
        line: isT ? null : clarifyMeaning.line,
        source: isT ? 't_concretize' : clarifyMeaning.source,
        meaning_kind: isT ? null : clarifyMeaning.kind,
        contract: isT
        ? pickRandom(contractsT)
        : isDefinitionQuestion
          ? ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'no_meta_explain', 'plain_words', 'no_boilerplate']
          : pickRandom(contractsClarify.slice(1)),
        rules: {
          ...(shiftPreset?.rules ?? {}),
          answer_user_meaning: true,
          keep_it_simple: true,
          no_flow_lecture: true,
          no_meta_explain: true,
          questions_max: isT ? 0 : isDefinitionQuestion ? 0 : 1,
          ...(deepReadBoost ? { no_definition: false } : {}),
        },
        allow: {
          ...(shiftPreset?.allow ?? {}),
          concrete_reply: true,
          short_reply_ok: isT ? false : true,
        },
        seed_text: seedText,
      }),
    },
    safe,
    buildNextHintSlot({ userText, laneKey: lane, flowDelta: delta }),
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

      // ✅ FIX: buildShiftTConcretize は「@SHIFT ...」を返すので、二重に m('SHIFT', ...) で包まない
      content: buildShiftTConcretize(seedText),
    });
  }

  return mapped;
}

// --------------------------------------------------
// Lane-specific SHIFT builders（自然文禁止）
// - ルールは shiftPresets に寄せる
// --------------------------------------------------

function buildShiftIdeaBand(seedText: string) {
  /**
   * ==================================================
   * IDEA_BAND（一点照射 / spotlight）
   *
   * - デフォルト 3行
   * - ユーザーが「4つ」「5案」など明示したら従う（最大5行）
   * - 最後の1行が “最有力（照射）”
   * - 候補行オンリー（質問/講義/手順なし）
   * ==================================================
   */

  // -----------------------------
  // ユーザーが指定した個数を抽出
  // -----------------------------
  const detectRequestedCount = (text: string): number | null => {
    const t0 = String(text ?? '');

    // ✅ 全角数字 → 半角へ（２〜５ / ４ / ５ を確実に拾う）
    const toHalfWidth = (s: string) =>
      s.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));

    const t = toHalfWidth(t0);

    // 例: "4つ" "5案" "4個" "5候補" "5行" "4パターン"
    const m = t.match(/([2-5])\s*(?:つ|案|個|パターン|候補|行)\b/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 2 && n <= 5) return n;
    }

    // 漢数字（簡易）
    if (/(?:二|２)\s*(?:つ|案|個|パターン|候補|行)/.test(t0)) return 2;
    if (/(?:三|３)\s*(?:つ|案|個|パターン|候補|行)/.test(t0)) return 3;
    if (/(?:四|４)\s*(?:つ|案|個|パターン|候補|行)/.test(t0)) return 4;
    if (/(?:五|５)\s*(?:つ|案|個|パターン|候補|行)/.test(t0)) return 5;

    return null;
  };


  const requested = detectRequestedCount(seedText);

  const lineCount = requested ?? 3; // デフォルト3

  const variants = [
    {
      kind: 'idea_band',
      intent: 'propose_candidates',
      rules: {
        ...SHIFT_PRESET_C_SENSE_HINT.rules,

        candidates_min: lineCount,
        candidates_max: lineCount,
        lines_max: lineCount,

        questions_max: 0,
        no_decision: true,
        no_action_commit: true,
        no_lecture: true,
        no_future_instruction: true,
        no_checklist: false,

        mode: 'spotlight',
        spotlight_last_line: true,
        spotlight_style: 'most_specific_no_label',
      },

      tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,

      allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), short_reply_ok: false },

      format: {
        lines: lineCount,
        schema: [`candidates(${lineCount}_lines_last_is_spotlight)`],
        line_contract: 'each_line_must_be_candidate',
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
  // ✅ t_concretize は「行動の押し付け」ではなく「対象の一点固定 → 最後に“具体1つ”」に寄せる
  // - ラベル（「次の一手：」「結論：」等）を禁止して、テンプレ臭を消す（B方針）
  // - 最終行に “具体を1つだけ” を必須（チェックリスト禁止）
  // - 10分/タイマー/姿勢など “時間・作法” は入れない（ユーザー方針）
  // - ACK + 一般論だけで終わらない

  const focus = typeof focusLabel === 'string' && focusLabel.trim() ? focusLabel.trim() : '';
  const raw = String(seedText ?? '').trim();

  // writer に渡す“内部seed”だけを濃くする（UIには露出しない想定）
  const packedSeed = [
    focus ? `対象：${focus}` : '',
    raw ? `状況：${raw}` : '',
    // ✅ ここがコア：出力フォーマットを固定（ラベル禁止 + 最終行は具体1つ）
    '出力ルール：ACKで終わらない／一般論で終わらない／ラベル（次の一手：・結論：・ポイント：など）を使わない',
    '形式：2〜3行。質問は最大1つまで。チェックリスト禁止。箇条書き禁止。',
    '最終行：状況に合わせた“具体の一手”を自然文で1つだけ（複数案/列挙/手順化はしない）。',
    '禁止：時間/タイマー/姿勢/習慣の指示。禁止語：選びました／視点を変えることで／次の一手：／結論：',
  ]
    .filter(Boolean)
    .join('\n');

    console.warn('[IROS/T_CONCRETIZE][SHIFT_BUILDER_USED]', {
      hasFocus: !!focus,
      seedHead: packedSeed.slice(0, 120),
      stack: new Error('SHIFT_BUILDER_USED').stack,
    });


  const payload = {
    kind: 't_concretize',
    intent: 'implement_next_step',
    rules: {
      ...(SHIFT_PRESET_T_CONCRETIZE.rules ?? {}),
      no_checklist: true,
      no_lecture: true,
      no_future_instruction: true, // 「〜しておくといい」系の未来講釈を抑制
      questions_max: 1,
      // 追加の“テンプレ抑制”は seed 側で強く縛る（ここは既存互換を維持）
    },
    seed_text: packedSeed,
    tone: SHIFT_PRESET_T_CONCRETIZE.tone ?? undefined,
    allow: SHIFT_PRESET_T_CONCRETIZE.allow ?? { concrete_reply: true, short_reply_ok: true },
  };

  // ✅ ここは「@SHIFT ...」そのものを返す（二重ラップ禁止）
  return `@SHIFT ${JSON.stringify(payload)}`;
}


// --- 置き換え：buildFlowReply を関数まるごと置き換え ---
function buildFlowReply(args: {
  userText: string;
  laneKey: LaneKey | null | undefined;
  flow: { delta: string; confidence?: number; returnStreak?: number } | null;
  lastUserText?: string | null;

  // ✅ A案：上流が「いま触る1点（対象）」を渡せる差し込み口
  focusLabel?: string;
}): NormalChatSlot[] {
  function buildShiftMeaningV1(input: {
    userText: string;
    flowDelta?: string | null;
    returnStreak?: number | null;
  }) {
    const t = norm(input.userText);
    const delta = String(input.flowDelta ?? '').trim().toUpperCase();
    const returnStreak =
      typeof input.returnStreak === 'number' && Number.isFinite(input.returnStreak)
        ? input.returnStreak
        : 0;

    const hasProgressWish =
      /(進みたい|進もう|進めたい|前に進みたい|変わりたい|抜けたい|抜け出したい|動きたい)/.test(t);

    const hasHoldWish =
      /(まだ動きたくない|動けない|止まりたい|休みたい|このままでいたい|怖い|不安|様子を見たい)/.test(t);

    const hasRepeatSense =
      /(また|同じ|戻っ|逆戻り|繰り返|ループ|堂々巡り)/.test(t);

    if (delta === 'RETURN') {
      if (hasProgressWish && hasHoldWish) {
        return {
          kind: 'structure',
          line: '進みたい気持ちと、まだ止まっていたい気持ちが同時に走っている状態',
          source: 'userText+flow',
        };
      }
      if (hasRepeatSense || returnStreak >= 2) {
        return {
          kind: 'redefine',
          line: '逆戻りというより、まだ抜けきっていない地点を整え直している流れ',
          source: 'flow',
        };
      }
      return {
        kind: 'redefine',
        line: '止まったのではなく、次に進む前の足場を戻って整えている流れ',
        source: 'flow',
      };
    }

    if (delta === 'HOLD' || delta === 'STAY') {
      if (hasProgressWish && hasHoldWish) {
        return {
          kind: 'structure',
          line: '前に進みたい意志はあるけれど、まだ動かすには早い部分が残っている状態',
          source: 'userText+flow',
        };
      }
      return {
        kind: 'reframe',
        line: '止まっているというより、いまは動くより保持を優先している状態',
        source: 'flow',
      };
    }

    if (delta === 'FORWARD') {
      if (hasProgressWish && hasHoldWish) {
        return {
          kind: 'reframe',
          line: '迷いが消えたわけではなく、迷いを抱えたままでも少し進める段階',
          source: 'userText+flow',
        };
      }
      return {
        kind: 'reframe',
        line: 'まだ完成していなくても、前に進みたい輪郭はもう出はじめている',
        source: 'flow',
      };
    }

    return {
      kind: 'reframe',
      line: 'いま起きていることを、そのまま次の動きにつながる形で見直す段階',
      source: 'flow',
    };
  }

  const t = norm(args.userText);
  const seedText = clamp(t, 240);

  const delta = args.flow?.delta ? String(args.flow.delta) : 'FORWARD';
  const conf = typeof args.flow?.confidence === 'number' ? args.flow.confidence : undefined;
  const returnStreak =
    typeof args.flow?.returnStreak === 'number' ? args.flow.returnStreak : undefined;

  const laneKeyRaw = args.laneKey;
  const laneKeyKnown: LaneKey | null =
    laneKeyRaw === 'T_CONCRETIZE' || laneKeyRaw === 'IDEA_BAND' ? laneKeyRaw : null;

  const hasAtDecl = /[@＠]/.test(t);
  const useIdeaBand = laneKeyKnown === 'IDEA_BAND' && hasAtDecl;
  const useTConcretize = laneKeyKnown === 'T_CONCRETIZE';

  const laneKeyForObs: LaneKey | null = useTConcretize
    ? 'T_CONCRETIZE'
    : useIdeaBand
      ? 'IDEA_BAND'
      : null;

  const shiftMeaning = buildShiftMeaningV1({
    userText: t,
    flowDelta: delta,
    returnStreak: returnStreak ?? null,
  });

  const hasAny = (...needles: string[]) =>
    needles.some((n) => t.includes(n) || t.toLowerCase().includes(n.toLowerCase()));

  const emotionalTemperature2 = (() => {
    const volatileHit =
      hasAny('わからない', '揺れる', 'ぐるぐる', '混乱', 'まとまらない') &&
      typeof returnStreak === 'number' &&
      returnStreak >= 2;

    if (volatileHit) return 'volatile' as const;

    if (
      (typeof returnStreak === 'number' && returnStreak >= 3) ||
      hasAny('苦しい', 'つらい', '怖い', 'しんどい', '限界')
    ) {
      return 'high' as const;
    }

    if (hasAny('迷う', '不安', '止まる', '動けない', 'どうしよう', '戻ってきた')) {
      return 'mid' as const;
    }

    return 'low' as const;
  })();

  const shiftKind2 = (() => {
    // ✅ 上流で確定した shiftKind を最優先
    const stampedShiftKind =
      String((args as any)?.context?.ctxPack?.shiftKind ?? '').trim() ||
      String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
      '';

    if (
      stampedShiftKind === 'clarify_shift' ||
      stampedShiftKind === 'stabilize_shift' ||
      stampedShiftKind === 'distance_shift' ||
      stampedShiftKind === 'repair_shift' ||
      stampedShiftKind === 'decide_shift'
    ) {
      return stampedShiftKind as
        | 'clarify_shift'
        | 'stabilize_shift'
        | 'distance_shift'
        | 'repair_shift'
        | 'decide_shift';
    }

    // ✅ 話題修正ターンは clarify を優先
    const topicCorrection =
      /(.+?)の話ですよ/u.test(t) ||
      /(.+?)のことです/u.test(t) ||
      /(その話です|そのことです|その件です)/u.test(t) ||
      /(さっきから言ってるのは.+です)/u.test(t);

    if (topicCorrection) {
      return 'clarify_shift' as const;
    }

    if (hasAny('って何', 'とは', '意味', '違い', '定義')) {
      return 'clarify_shift' as const;
    }

    if (
      delta === 'RETURN' ||
      hasAny('戻ってきた', '動けない', '止まる', 'しんどい', 'また同じところ') ||
      emotionalTemperature2 === 'high' ||
      emotionalTemperature2 === 'volatile'
    ) {
      return 'stabilize_shift' as const;
    }

    if (
      hasAny('相手', '恋愛', '関係', '距離', '気持ち', '連絡', '既読', '未読') &&
      hasAny('距離を置かれてる', '遠い', '近すぎる', '追いかけ', '避け', 'わからない')
    ) {
      return 'distance_shift' as const;
    }

    if (hasAny('仲直り', '修復', '戻りたい', 'やり直したい')) {
      return 'repair_shift' as const;
    }

    if (hasAny('決められない', '行くべきか', 'やめるべきか', '迷ってる', '選べない')) {
      return 'decide_shift' as const;
    }

    if (hasAny('何から', '何が不安かわからない', '整理したい', '焦点')) {
      return 'narrow_shift' as const;
    }

    return 'narrow_shift' as const;
  })();

  const shiftHint2 = (() => {
    if (shiftKind2 === 'clarify_shift') return 'clarify_meaning_v2';
    if (shiftKind2 === 'stabilize_shift') return 'stabilize_shift_v1';
    if (shiftKind2 === 'distance_shift') return 'distance_shift_v1';
    if (shiftKind2 === 'repair_shift') return 'repair_shift_v1';
    if (shiftKind2 === 'decide_shift') return 'decide_shift_v1';
    return 'narrow_shift_v1';
  })();

  const shiftIntent2 = (() => {
    if (shiftKind2 === 'clarify_shift') return 'meaning_reframe';
    if (shiftKind2 === 'stabilize_shift') return 'stabilize_direction';
    if (shiftKind2 === 'distance_shift') return 'distance_tuning';
    if (shiftKind2 === 'repair_shift') return 'repair_entry';
    if (shiftKind2 === 'decide_shift') return 'decision_axis';
    return 'narrow_focus';
  })();

  const shiftLine2 = (() => {
    if (shiftKind2 === 'clarify_shift') {
      const isTopicCorrection =
        t.length <= 24 &&
        !/[?？]/.test(t) &&
        (hasAny('話ですよ', 'の話', 'のこと', 'について') ||
          /.+の話(です|だ)?よ?$/.test(t));

      const isDefinitionQuestion2 =
        /(?:って何|とは|意味|違い|定義)/.test(t) || /[?？]/.test(t);

      if (isTopicCorrection) {
        return '話題の補正として受け取り、何の話かを勝手に広げず、その話題の中で確認する';
      }

      if (isDefinitionQuestion2) {
        return shiftMeaning.line;
      }

      return '質問の向きをそのまま受け取り、話題を広げずに、このテーマのどこを知りたいのかを狭く確かめる';
    }

    if (shiftKind2 === 'stabilize_shift') {
      if (hasAny('また同じところ', '戻ってきた')) {
        return 'いまは進めることより、同じところに見える一点を静かに整え直す角度が合っている';
      }
      return 'いまは進めるより、足場を戻して整える角度のほうが合っている';
    }

    if (shiftKind2 === 'distance_shift') {
      return '相手を読み切るより先に、いま苦しくしている距離の一点を狭く見たほうが動きやすい';
    }

    if (shiftKind2 === 'repair_shift') {
      return '正解の修復を急ぐより、関係を壊さない入口を一つだけ置く角度が合っている';
    }

    if (shiftKind2 === 'decide_shift') {
      return '結論を急ぐより先に、何を基準に決めるかを一つに絞る角度が合っている';
    }

    return '全部を動かすより、いま引っかかっている一点だけを狭くすると動きやすい';
  })();

  const questionsMax2 =
    shiftKind2 === 'clarify_shift' ||
    shiftKind2 === 'stabilize_shift' ||
    shiftKind2 === 'distance_shift' ||
    emotionalTemperature2 === 'high' ||
    emotionalTemperature2 === 'volatile'
      ? 0
      : 1;

  const shift =
    useTConcretize
      ? buildShiftTConcretize(seedText, args.focusLabel)
      : useIdeaBand
        ? buildShiftIdeaBand(seedText)
        : m('SHIFT', {
            kind: shiftKind2,
            intent: shiftIntent2,
            hint: shiftHint2,
            line: shiftLine2,
            source: 'phase2_shift',
            rules: {
              answer_user_meaning: true,
              keep_it_simple: true,
              no_flow_lecture: true,
              no_meta_explain: true,
              questions_max: questionsMax2,
            },
            allow: {
              concrete_reply: true,
              short_reply_ok: true,
            },
            seed_text: seedText,
          });

  return [
    {
      key: 'OBS',
      role: 'assistant',
      style: 'soft',
      content: m('OBS', {
        laneKey: laneKeyForObs,
        flow: conf === undefined ? { delta } : { delta, confidence: conf },
      }),
    },
    {
      key: 'SHIFT',
      role: 'assistant',
      style: 'neutral',
      content: shift,
    },
    {
      key: 'SAFE',
      role: 'assistant',
      style: 'soft',
      content: m('SAFE', {
        laneKey: laneKeyForObs,
        flow: conf === undefined ? { delta } : { delta, confidence: conf },
      }),
    },
    buildNextHintSlot({ userText: t, laneKey: laneKeyForObs as any, flowDelta: delta }),
  ];
}

// ✅ 置き換え 1) safeLaneKey を関数まるごと置き換え
function safeLaneKey(v: unknown): LaneKey | null {
  return v === 'IDEA_BAND' || v === 'T_CONCRETIZE' ? v : null;
}

// ✅ 置き換え 2) buildNextHintSlot の JSON.stringify 内「laneKey」行だけ置き換え
// 変更前: laneKey,
// 変更後:


// ✅ 置き換え 3) buildNormalChatSlotPlan を関数まるごと差し替え
export function buildNormalChatSlotPlan(args: {
  userText: string;
  laneKey?: LaneKey;
  focusLabel?: string;
  context?: {
    recentUserTexts?: string[];
    lastSummary?: string | null;
  };
}): NormalChatSlotPlan {
  const laneKey = safeLaneKey(args.laneKey);
  const laneKeyArg: LaneKey | undefined = laneKey ?? undefined;

  const stamp = `normalChat@lane:${laneKey ?? 'none'}@no-seed-text+random-hints+questionSlots+nextHint`;
  const userText = norm(args.userText);

  const recentRaw = Array.isArray(args.context?.recentUserTexts) ? args.context!.recentUserTexts! : [];
  const recent = recentRaw.map((x) => norm(x)).filter(Boolean);
  const lastUserText = recent.length > 0 ? recent[recent.length - 1] : null;

  // ✅ prevReturnStreak を recentUserTexts の末尾から復元（状態は持たない）
  const prevReturnStreak = (() => {
    if (recent.length < 2) return 0;

    const isReturnPair = (cur: string, prev: string) => {
      const c = norm(cur);
      const p = norm(prev);
      if (!p) return false;

      const sameHead = c.slice(0, 12) === p.slice(0, 12);
      const overlap =
        c.length && p.length
          ? c.split(' ').filter((w) => p.includes(w)).length / Math.max(1, c.split(' ').length)
          : 0;

      return sameHead || overlap > 0.6;
    };

    let streak = 0;
    for (let i = recent.length - 1; i >= 1; i--) {
      if (isReturnPair(recent[i]!, recent[i - 1]!)) streak++;
      else break;
    }
    return streak;
  })();

  let flow: { delta: string; confidence?: number; returnStreak?: number } | null = null;
  try {
    flow = observeFlow({
      currentText: userText,
      lastUserText: lastUserText ?? undefined,
      prevReturnStreak,
    }) as any;
  } catch {
    flow = { delta: 'FORWARD', returnStreak: 0 };
  }

  const flowDelta = flow?.delta ? String(flow.delta) : null;

  let reason = 'flow';
  let slots: NormalChatSlot[] = [];

  // ✅ 分岐フラグ（@Q を入れる条件の確証に使う）
  let usedQuestionSlots = false;
  let usedClarify = false;

  if (!userText) {
    reason = 'empty';
    slots = buildEmpty();
  } else if (isEnd(userText)) {
    reason = 'end';
    slots = buildEnd();
  } else if (shouldUseQuestionSlots(userText)) {
    reason = 'questionSlots';
    usedQuestionSlots = true;
    slots = buildQuestion(userText, lastUserText ?? undefined, laneKeyArg, flowDelta);
  } else if (isClarify(userText) && /[?？]/.test(userText)) {
    reason = 'clarify';
    usedClarify = true;
    slots = buildClarify(userText, laneKeyArg, flowDelta, flow as any);
  } else if (isCompose(userText)) {
    reason = 'compose';
    slots = buildCompose(userText, laneKeyArg, flowDelta);
  } else {
    const d = flow?.delta ? String(flow.delta) : 'FORWARD';
    reason = `flow:${d}`;
    slots = buildFlowReply({ userText, laneKey, flow, lastUserText, focusLabel: args.focusLabel });
  }

  const normalized = normalizeSlots(slots);
  if (normalized.length === 0) {
    reason = 'guard:no_slots_after_normalize';
    slots = [buildNextHintSlot({ userText, laneKey: laneKeyArg, flowDelta: flowDelta ?? 'FORWARD' })];
  } else {
    slots = normalized;
  }

  // --------------------------------------------------
  // ✅ recall-must-include の差し込み（slot数は増やさない）
  // - rephraseEngine は SHIFT を seed に混ぜるので、ここに @RESTORE/@Q を追加すると拾える
  // --------------------------------------------------
  const buildRecallAppend = (): string => {
    const lines: string[] = [];

    // (A) RESTORE：復元したい“前の一文”が context.lastSummary に入ってる場合だけ
    //  トリガーは最低限（戻して/復元/もう一回/さっき/前の）
    const lastSummary = norm(String(args.context?.lastSummary ?? ''));
    const wantsRestore = /戻(して|す)|復元|もう一回|さっき|前の/.test(userText);
    if (wantsRestore && lastSummary) {
      lines.push(`@RESTORE ${JSON.stringify({ last: clamp(lastSummary, 220) })}`);
    }

    // (B) Q：質問系（QuestionSlots or Clarify or "？/?"）のときだけ
    const wantsQ = usedQuestionSlots || usedClarify || /[?？]/.test(userText);
    if (wantsQ) {
      lines.push(`@Q ${JSON.stringify({ ask: clamp(userText, 220) })}`);
    }

    return lines.length ? `\n${lines.join('\n')}` : '';
  };

  const recallAppend = buildRecallAppend();
  if (recallAppend) {
    slots = slots.map((s) => {
      if (s?.key !== 'SHIFT') return s;
      const c = String(s.content ?? '');
      // 念のため二重付与しない
      if (c.includes('@RESTORE') || c.includes('@Q ')) return s;
      return { ...s, content: c + recallAppend };
    });
  }

  return {
    kind: 'normal-chat',
    stamp,
    reason,
    slotPlanPolicy: reason === 'empty' ? 'UNKNOWN' : 'FINAL',
    slots,
  };
}
