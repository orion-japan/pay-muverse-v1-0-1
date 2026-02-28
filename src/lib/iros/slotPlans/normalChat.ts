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
        : '流れを保ったまま前に進める';

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

// ✅ clarify：テンプレ自然文を出さない。LLMに “意味に答える” を許可するだけ。
// ✅ FIX: laneKey 未指定(null/undefined)を勝手に T_CONCRETIZE にしない（t_concretize seed支配の原因）
function buildClarify(
  userText: string,
  laneKey?: LaneKey,
  flowDelta?: string | null,
  flow?: { delta?: string; confidence?: number; returnStreak?: number } | null
): NormalChatSlot[] {
  const lane = laneKey; // ここで補完しない（未指定なら undefined のまま）
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

  // ✅ どの経路でも OBS を固定で出す（生文は入れない：構造だけ）
  const obs: NormalChatSlot = {
    key: 'OBS',
    role: 'assistant',
    style: 'soft',
    content: m('OBS', {
      laneKey: lane ?? null, // 未指定は null のまま出す
      flow: { delta },
      // 🚫 生文遮断：user / lastUserText を slot に入れない
      user: null,
      lastUserText: null,
    }),
  };

  // ✅ IDEA_BAND: clarify でも候補契約へ（質問返し/講義/手順を抑える）
  if (lane === 'IDEA_BAND') {
    return [
      obs,
      {
        key: 'SHIFT',
        role: 'assistant',
        style: 'neutral',
        content: buildShiftIdeaBand(seedText),
      },
      buildNextHintSlot({ userText, laneKey: lane, flowDelta: delta }),
    ];
  }

  const shiftPreset = isT ? SHIFT_PRESET_T_CONCRETIZE : null;

  // deepReadBoost: RETURN が続く “確認モード” 局面だけ、定義（構造説明）を少し許可
  // - 命名（no_naming）は絶対に緩めない
  // - no_definition だけを false に落とす（RETURN streak>=2 のときだけ）
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
        intent: isT ? 'implement_next_step' : 'answer_the_question',
        contract: pickRandom(isT ? contractsT : contractsClarify),
        rules: {
          ...(shiftPreset?.rules ?? {}),
          answer_user_meaning: true,
          keep_it_simple: true,
          questions_max: isT ? 0 : 1,

          // ✅ RETURN streak>=2 の時だけ「定義/構造説明」を許可
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
  flow: { delta: string; confidence?: number } | null;
  lastUserText?: string | null;

  // ✅ A案：上流が「いま触る1点（対象）」を渡せる差し込み口
  focusLabel?: string;
}): NormalChatSlot[] {
  const t = norm(args.userText);
  const seedText = clamp(t, 240);

  // ✅ TSエラー原因：delta/conf が未宣言だったので復活
  const delta = args.flow?.delta ? String(args.flow.delta) : 'FORWARD';
  const conf = typeof args.flow?.confidence === 'number' ? args.flow!.confidence : undefined;

  // ✅ laneKey は「明示されたときだけ」使う。null/不明は通常扱い（IDEA_BANDにも落とさない）
  const laneKeyRaw = args.laneKey;
  const laneKeyKnown: LaneKey | null =
    laneKeyRaw === 'T_CONCRETIZE' || laneKeyRaw === 'IDEA_BAND' ? laneKeyRaw : null;

  // ✅ IDEA_BAND は「選択宣言（＠）」があるときだけ（要件通り）
  const hasAtDecl = /[@＠]/.test(t);
  const useIdeaBand = laneKeyKnown === 'IDEA_BAND' && hasAtDecl;

  // ✅ T_CONCRETIZE も「明示されたときだけ」
  const useTConcretize = laneKeyKnown === 'T_CONCRETIZE';

  // OBSに載せるlaneKeyも同じ基準（nullのままOK）
  const laneKeyForObs: LaneKey | null = useTConcretize ? 'T_CONCRETIZE' : useIdeaBand ? 'IDEA_BAND' : null;

  const shift =
    useTConcretize
      ? buildShiftTConcretize(seedText, args.focusLabel)
      : useIdeaBand
        ? buildShiftIdeaBand(seedText)
        : m('SHIFT', {
            kind: 'c_sense_hint',
            intent: 'continue_flow',
            rules: {
              ...(SHIFT_PRESET_C_SENSE_HINT.rules ?? {}),
              questions_max: 1,
              no_checklist: true,
              no_future_instruction: true,
              no_lecture: true,
              no_decision: true,
              no_action_commit: true,
            },
            tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,
            allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), short_reply_ok: false },
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
                // 🚫 生文は入れない（user / lastUserText は slot から完全排除）
              }),
            },
            {
              key: 'SHIFT',
              role: 'assistant',
              style: 'neutral',
              content: shift,
            },

            // ✅ SAFE を常駐（slotPlan=4を安定させる）
            {
              key: 'SAFE',
              role: 'assistant',
              style: 'soft',
              content: m('SAFE', {
                laneKey: laneKeyForObs,
                flow: conf === undefined ? { delta } : { delta, confidence: conf },
              }),
            },

            // ✅ Phase11 advance測定用の橋（通常フローでも必ず出す）
            // laneKeyはnullでも落ちないように（型が厳しい場合があるのでas anyで通す）
            buildNextHintSlot({ userText: t, laneKey: laneKeyForObs as any, flowDelta: delta }),
          ];


// ✅ 置き換え：src/lib/iros/slotPlans/normalChat.ts
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
  // - 直前ターンの「RETURN連続回数」を推定して observeFlow に渡す
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

  if (!userText) {
    reason = 'empty';
    slots = buildEmpty();
  } else if (isEnd(userText)) {
    reason = 'end';
    slots = buildEnd();
  } else if (shouldUseQuestionSlots(userText)) {
    reason = 'questionSlots';
    slots = buildQuestion(userText, lastUserText ?? undefined, laneKeyArg, flowDelta);
  } else if (isClarify(userText) && /[?？]/.test(userText)) {
    reason = 'clarify';
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

  return {
    kind: 'normal-chat',
    stamp,
    reason,
    slotPlanPolicy: reason === 'empty' ? 'UNKNOWN' : 'FINAL',
    slots,
  };
}
