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
// ※契約の“正本”は buildShiftIdeaBand() 直上のコメントに示す（重複させない）
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
    let safePayload: Record<string, unknown> = { ...payload };

    // ✅ SHIFT は「焦点/意図」だけを持つ
    // - 質問可否は contractObj / writer contract 側の正本に一本化する
    // - ここで questions 系を必ず落として、SHIFT rules との矛盾を止める
    if (tag === 'SHIFT') {
      const rawRules = safePayload.rules;
      if (rawRules && typeof rawRules === 'object' && !Array.isArray(rawRules)) {
        const {
          questions_max: _questions_max,
          no_question_back: _no_question_back,
          no_question_end: _no_question_end,
          ...restRules
        } = rawRules as Record<string, unknown>;

        safePayload = {
          ...safePayload,
          rules: restRules,
        };
      }
    }

    return `@${tag} ${JSON.stringify(safePayload)}`;
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
  const laneKey = safeLaneKey(args.laneKey);
  const delta = args.flowDelta ? String(args.flowDelta) : null;

  const hint =
    laneKey === 'T_CONCRETIZE'
      ? 'いま表に出ている一点をそのまま保つ'
      : laneKey === 'IDEA_BAND'
        ? '候補を増やさず、いま出ている差だけを見やすくする'
        : 'いま出ている流れを崩さず、そのまま整えて返す';

  return {
    key: 'NEXT',
    role: 'assistant',
    style: 'neutral',
    content: `@NEXT_HINT ${JSON.stringify({
      mode: 'observe_hint',
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
  flow?: { delta?: string; confidence?: number; returnStreak?: number } | null,
  resolvedAskTypeArg?: string | null,
  questionArg?: any,
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

  const questionType = String(questionArg?.questionType ?? '').trim();
  const tMode = String(questionArg?.tState?.mode ?? '').trim();
  const outputPolicy = questionArg?.outputPolicy ?? null;

  const tStateFocus = String(questionArg?.tState?.focus ?? '').trim();
  const focusCandidateRaw = Array.isArray(questionArg?.iframe?.focusCandidate)
    ? questionArg.iframe.focusCandidate
    : [];
  const focusCandidateTop =
    focusCandidateRaw.length > 0 ? String(focusCandidateRaw[0] ?? '').trim() : '';
  const questionFocus = tStateFocus || focusCandidateTop;

  const usePastReframe = !!outputPolicy?.usePastReframe;
  const splitFactHypothesis = !!outputPolicy?.splitFactHypothesis;
  const avoidPrematureClosure = !!outputPolicy?.avoidPrematureClosure;

  const questionSuggestsTruthStructure =
    questionType === 'structure' || questionType === 'truth';

  const questionSuggestsPastReframe =
    questionType === 'unresolved_release' ||
    tMode === 'reobserve_past' ||
    usePastReframe;

  const buildClarifyMeaningV1 = (
    text: string,
  ): {
    kind: 'define' | 'reframe' | 'structure' | 'topic_recall';
    line: string;
    source: string;
  } => {
    const t = norm(text);

    if (
      /(構造から|構造で|構造に|構造へ)/.test(t) ||
      /(置き換える|置換|写像|翻訳|言い換える)/.test(t) ||
      /(外因|内因|因果|因果配置|事実層|物語層|意味層)/.test(t)
    ) {
      return {
        kind: 'structure',
        line: 'いま必要なのは題材そのものの賛否ではなく、その話を因果配置や層の違いに分けて構造語へ写し直すこと',
        source: 'question_pattern',
      };
    }

    if (
      /(なんの話|何の話|この話|その話|今の話|さっきの話|いまの話|今の流れ|この流れ|その流れ)/.test(t) ||
      /(それじゃなくて|それじゃない|そうじゃなくて|そのこと|その件|これのこと|それのこと)/.test(t) ||
      (/わかる/.test(t) && /(話|流れ|こと)/.test(t))
    ) {
      return {
        kind: 'topic_recall',
        line: 'いまの問いでは、確認や位置合わせではなく、直前まで何について話していたかを一発で言い直す',
        source: 'topic_recall',
      };
    }

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

    const normalizedUserText = norm(userText);
    const resolvedAskType: string = (() => {
      const stamped = String(resolvedAskTypeArg ?? '').trim();
      if (stamped) return stamped;

      const looksTruthStructure =
        /(地球外生命体|宇宙人)/.test(normalizedUserText) &&
        /(人間|人類)/.test(normalizedUserText) &&
        /(作った|作られた|介入)/.test(normalizedUserText) &&
        /(構造)/.test(normalizedUserText);

      return looksTruthStructure ? 'truth_structure' : '';
    })();

  console.log('[IROS/NORMAL_CHAT][BUILD_CLARIFY_TRACE]', {
    userHead: String(userText ?? '').slice(0, 80),
    resolvedAskTypeArg: String(resolvedAskTypeArg ?? ''),
    resolvedAskType,
    lane,
    isT,
    normalizedUserText: normalizedUserText.slice(0, 120),
    questionType,
    tMode,
    questionFocus: questionFocus || null,
    usePastReframe,
    splitFactHypothesis,
    avoidPrematureClosure,
  });

  const directAnswerRequested =
    /答え|結論|要するに|結局|真実が知りたい|本当のことが知りたい|そろそろ結論|今の未来|未来だよ/.test(seedText);

  const hasTruthStructureLexeme =
    /(真実|事実|本当|構造|論点|検証|仮説|どこまで言える|切り分け|整理)/.test(normalizedUserText) ||
    (
      /(地球外生命体|宇宙人)/.test(normalizedUserText) &&
      /(人間|人類)/.test(normalizedUserText) &&
      /(作った|作られた|介入)/.test(normalizedUserText)
    );

    const isStructureQuestion = questionType === 'structure';

    const shouldAnswerTruthStructure =
      resolvedAskType === 'truth_structure' ||
      isStructureQuestion ||
      (questionSuggestsTruthStructure && hasTruthStructureLexeme);

    const shouldReanswerCapability =
      resolvedAskType === 'capability_reask';

    const shiftIntentBase =
      isT
        ? 'implement_next_step'
        : questionSuggestsPastReframe
          ? 'answer_past_reframe'
          : shouldReanswerCapability
            ? 'reanswer_capability'
            : directAnswerRequested
              ? 'answer_in_one_shot'
              : shouldAnswerTruthStructure
                ? 'answer_truth_structure'
                : 'answer_user_meaning';

    const shiftHintBase =
      isT
        ? 'clarify_t_concretize_v1'
        : shouldReanswerCapability
          ? 'repair_capability_reask_v1'
          : shouldAnswerTruthStructure
            ? 'clarify_truth_structure_v1'
            : directAnswerRequested
              ? 'decide_shift_v1'
              : 'clarify_meaning_v1';

    const shiftLineBase =
      isT
        ? null
        : questionSuggestsPastReframe
          ? 'いま必要なのは解決を急いで断定することではなく、戻ってきた未完了の型を見つけて、未完了テーマ・反復パターン・再配置の順で見直すこと'
          : shouldReanswerCapability
            ? '前に聞かれた問いを短く言い直してから、「何ができるのか」をできることの形で先に直答する。型の説明や感情の意味づけには広げず、1行目で機能を言い切り、そのあと必要最小限の具体例だけを添える'
            : directAnswerRequested
              ? '結論を先に短く言い切り、そのあと必要最小限の具体だけを添えて閉じる'
              : shouldAnswerTruthStructure
              ? '結論を先に1〜2文で言い切り、そのあとでどこが未確定なのかを短い本文でそのまま続ける。見出しや箇条書きにはせず、観測→芯→具体の順を一続きの文脈で返す'
              : clarifyMeaning.line;
                const askBackAllowedNow =
                  !isT &&
                  !questionSuggestsPastReframe &&
                  !shouldAnswerTruthStructure &&
                  !shouldReanswerCapability &&
                  clarifyMeaning.kind !== 'topic_recall' &&
                  !isDefinitionQuestion &&
                  questionType === 'meaning' &&
                  tMode !== 'confirm';

                const isMeaningConfirm =
                  !isT &&
                  !questionSuggestsPastReframe &&
                  !shouldAnswerTruthStructure &&
                  !shouldReanswerCapability &&
                  clarifyMeaning.kind !== 'topic_recall' &&
                  !isDefinitionQuestion &&
                  questionType === 'meaning' &&
                  tMode === 'confirm';

              return [
                obs,
                {
                  key: 'SHIFT',
                  role: 'assistant',
                  style: 'neutral',
                  content: m('SHIFT', {
                    kind: isT ? 't_concretize' : 'clarify',
                    intent: shiftIntentBase,
                    hint: shiftHintBase,
                    line: shiftLineBase,
                    source: isT
                      ? 't_concretize'
                      : questionSuggestsPastReframe
                        ? 'question_engine'
                        : shouldAnswerTruthStructure
                          ? 'resolved_ask'
                          : shouldReanswerCapability
                            ? 'resolved_ask'
                            : clarifyMeaning.source,
                    meaning_kind: isT
                      ? null
                      : questionSuggestsPastReframe
                        ? 'past_reframe'
                        : shouldAnswerTruthStructure
                          ? 'truth_structure'
                          : shouldReanswerCapability
                            ? 'capability_reask'
                            : clarifyMeaning.kind,
                    question_type: questionType || null,
                    t_mode: tMode || null,
                    question_focus: questionFocus || null,
                    contract: isT
                      ? ['first_line_is_core', 'one_next_step', 'plain_words']
                      : questionSuggestsPastReframe
                        ? ['answer_in_one_shot', 'prefer_past_reframe_over_advice', 'plain_words']
                        : shouldReanswerCapability
                          ? ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'plain_words']
                          : shouldAnswerTruthStructure
                            ? ['answer_in_one_shot', 'first_line_is_core_answer', 'then_structure_brief', 'plain_words']
                            : clarifyMeaning.kind === 'topic_recall'
                              ? ['answer_in_one_shot', 'first_line_names_last_topic_directly', 'plain_words']
                              : isDefinitionQuestion
                                ? ['answer_in_one_shot', 'first_line_is_definition_or_pointing', 'plain_words']
                                : questionType === 'meaning'
                                  ? ['answer_in_one_shot', 'first_line_is_core_answer', 'plain_words']
                                  : ['answer_in_one_shot', 'plain_words'],
                                  rules: {
                                    ...(shiftPreset?.rules ?? {}),
                                    answer_user_meaning:
                                      !questionSuggestsPastReframe &&
                                      !shouldAnswerTruthStructure &&
                                      !shouldReanswerCapability,
                                    answer_truth_structure: shouldAnswerTruthStructure,
                                    use_past_reframe: questionSuggestsPastReframe,
                                    no_flow_lecture: true,
                                    no_meta_explain: true,
                                    output_only:
                                      shouldAnswerTruthStructure ||
                                      shouldReanswerCapability ||
                                      clarifyMeaning.kind === 'topic_recall' ||
                                      isDefinitionQuestion ||
                                      isMeaningConfirm,
                                    no_bullets:
                                      shouldAnswerTruthStructure ||
                                      shouldReanswerCapability ||
                                      clarifyMeaning.kind === 'topic_recall' ||
                                      isDefinitionQuestion ||
                                      isMeaningConfirm,
                                    lines_max:
                                      shouldAnswerTruthStructure
                                        ? 4
                                        : shouldReanswerCapability
                                          ? 3
                                          : clarifyMeaning.kind === 'topic_recall'
                                            ? 3
                                            : isDefinitionQuestion
                                              ? 3
                                              : isMeaningConfirm
                                                ? 6
                                                : undefined,
                      questions_max:
                        isMeaningConfirm
                          ? 0
                          : askBackAllowedNow === false
                            ? 0
                            : isT
                              ? 0
                              : questionSuggestsPastReframe
                                ? 0
                                : shouldAnswerTruthStructure
                                  ? 0
                                  : shouldReanswerCapability
                                    ? 1
                                    : clarifyMeaning.kind === 'topic_recall'
                                      ? 0
                                      : isDefinitionQuestion
                                        ? 0
                                        : questionType === 'meaning'
                                          ? 1
                                          : 2,
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

  // ✅ 上流で確定した shiftKind / resolvedAsk を拾うための差し込み口
  ctxPack?: any;
  meta?: any;
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

    const observedStage2 =
      String((args as any)?.ctxPack?.observedStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.observedStage ?? '').trim() ||
      '';

    const primaryStage2 =
      String((args as any)?.ctxPack?.primaryStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.primaryStage ?? '').trim() ||
      '';

    const secondaryStage2 =
      String((args as any)?.ctxPack?.secondaryStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.secondaryStage ?? '').trim() ||
      '';

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
        line: '止まったのではなく、次に進む前の基準を戻って整えている流れ',
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
      if (observedStage2.startsWith('I') && primaryStage2.startsWith('R')) {
        return {
          kind: 'reframe',
          line: '関係の反復を追い続けるより先に、この流れが自分にとって何を意味しているのかを確かめたい段階',
          source: 'flow+observedStage',
        };
      }

      if (observedStage2.startsWith('I')) {
        return {
          kind: 'reframe',
          line: '出来事を整理し切ることより、この流れにどんな意味を示すと腑に落ちるかを確かめたい段階',
          source: 'flow+observedStage',
        };
      }

      if (observedStage2.startsWith('R') && secondaryStage2.startsWith('I')) {
        return {
          kind: 'reframe',
          line: '関係の中で繰り返される形を見ながら、その背景で何を意味づけようとしているのかも拾いたい段階',
          source: 'flow+observedStage',
        };
      }

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
  console.log('[IROS/NORMAL_CHAT][SHIFT_INPUTS]', {
    stampedShiftKind:
      String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||
      '',
    resolvedAskType:
      String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      '',
    hasCtxPack: !!(args as any)?.ctxPack,
    hasMeta: !!(args as any)?.meta,
    userHead: String(args.userText ?? '').slice(0, 60),
  });
  const shiftKind2 = (() => {
    const stampedShiftKind =
      String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||
      '';

    const directAnswerRequested2 = hasAny(
      '答え',
      '結論',
      '要するに',
      '結局',
      '真実が知りたい',
      '本当のことが知りたい',
      'そろそろ結論',
      '今の未来',
      '未来だよ',
    );

    const resolvedAskType =
      String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      '';

    const isClarifyLike =
      isClarify(t) ||
      resolvedAskType === 'truth_structure' ||
      resolvedAskType === 'meaning' ||
      resolvedAskType === 'definition' ||
      resolvedAskType === 'topic_clarify';

    const isReturnFlow = String(delta ?? '').trim().toUpperCase() === 'RETURN';

    // ① 上流確定があれば最優先
    if (
      stampedShiftKind === 'clarify_shift' ||
      stampedShiftKind === 'stabilize_shift' ||
      stampedShiftKind === 'distance_shift' ||
      stampedShiftKind === 'repair_shift' ||
      stampedShiftKind === 'decide_shift' ||
      stampedShiftKind === 'narrow_shift'
    ) {
      return stampedShiftKind as
        | 'clarify_shift'
        | 'stabilize_shift'
        | 'distance_shift'
        | 'repair_shift'
        | 'decide_shift'
        | 'narrow_shift';
    }

    // ② 明示的な結論要求は decide
    if (directAnswerRequested2) {
      return 'decide_shift' as const;
    }

    // ③ 意味/定義/真意/ツッコミ系は clarify を優先
    //    RETURN 中でもこちらを優先して、stabilize に吸われないようにする
    if (isClarifyLike) {
      return 'clarify_shift' as const;
    }

    // ④ 関係距離・修復・決定の明示語
    if (hasAny('距離', '近すぎる', '離れたい', '遠い', '重い')) {
      return 'distance_shift' as const;
    }

    if (hasAny('仲直り', '修復', 'やり直したい', '戻りたい')) {
      return 'repair_shift' as const;
    }

    if (hasAny('決められない', '迷ってる', '選べない', 'やめるべきか', '行くべきか')) {
      return 'decide_shift' as const;
    }

    // ⑤ RETURN は「全部 stabilize」にせず、
    //    明確な停滞語がある時だけ stabilize にする
    if (
      hasAny('また同じところ', '戻ってきた', '動けない', '止まる', 'しんどい') ||
      (isReturnFlow && emotionalTemperature2 === 'high')
    ) {
      return 'stabilize_shift' as const;
    }

    // ⑥ それ以外は narrow
    if (
      /^(?:こんにちは|こんちわ|こんばんは|おはよう|やあ|どうも|もしもし|おつかれ|おつかれさま|ただいま)$/u.test(
        String(t ?? '').trim(),
      )
    ) {
      return 'stabilize_shift' as const;
    }

    return 'narrow_shift' as const;
  })();

  const resolvedAskType2 =
    String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    '';

  const shiftHint2 = (() => {
    if (shiftKind2 === 'clarify_shift') {
      if (resolvedAskType2 === 'truth_structure') return 'clarify_truth_structure_v1';
      return 'clarify_meaning_v2';
    }

    if (shiftKind2 === 'stabilize_shift') return 'stabilize_shift_v1';
    if (shiftKind2 === 'distance_shift') return 'distance_shift_v1';
    if (shiftKind2 === 'repair_shift') return 'repair_shift_v1';
    if (shiftKind2 === 'decide_shift') return 'decide_shift_v1';
    return 'narrow_shift_v1';
  })();

  const shiftIntent2 = (() => {
    if (shiftKind2 === 'clarify_shift') {
      if (resolvedAskType2 === 'truth_structure') return 'answer_truth_structure';
      return 'meaning_reframe';
    }

    if (shiftKind2 === 'stabilize_shift') return 'stabilize_direction';
    if (shiftKind2 === 'distance_shift') return 'distance_tuning';
    if (shiftKind2 === 'repair_shift') return 'repair_entry';
    if (shiftKind2 === 'decide_shift') return 'answer_in_one_shot';
    return 'narrow_focus';
  })();

  const shiftLine2 = (() => {
    const observedStage2 =
      String((args as any)?.ctxPack?.observedStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.observedStage ?? '').trim() ||
      '';

    const primaryStage2 =
      String((args as any)?.ctxPack?.primaryStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.primaryStage ?? '').trim() ||
      '';

    const secondaryStage2 =
      String((args as any)?.ctxPack?.secondaryStage ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.secondaryStage ?? '').trim() ||
      '';

    if (shiftKind2 === 'clarify_shift') {
      const isTopicCorrection =
        t.length <= 24 &&
        !/[?？]/.test(t) &&
        (hasAny('話ですよ', 'の話', 'のこと', 'について') ||
          /.+の話(です|だ)?よ?$/.test(t));

      const isDefinitionQuestion2 =
        /(?:って何|とは|意味|違い|定義)/.test(t) || /[?？]/.test(t);

        if (resolvedAskType2 === 'truth_structure') {
          return '答えの核と、そのまわりの構造を混ぜずに整理します';
        }

        if (isTopicCorrection) {
          return '補正された話題の範囲を広げず、そのテーマの中で整理します';
        }

        if (observedStage2.startsWith('I') && primaryStage2.startsWith('R')) {
          return '関係の繰り返しと、その受け取り方を分けて見ていきます';
        }

        if (observedStage2.startsWith('I')) {
          return '出来事より、その流れの受け取り方に焦点を当てて整理します';
        }

        if (observedStage2.startsWith('R') && secondaryStage2.startsWith('I')) {
          return '関係の繰り返しと、その背景にある意味づけを分けて見ていきます';
        }

        if (isDefinitionQuestion2) {
          return shiftMeaning.line;
        }

        return '質問の広がりを抑え、このテーマの核に焦点を当てます';
      }

      if (shiftKind2 === 'stabilize_shift') {
        if (hasAny('また同じところ', '戻ってきた')) {
          return '同じ場所に戻っている一点を基準に整理します';
        }
        return '揺れている基準の位置を、そのまま見直す方向で整理します';
      }

      if (shiftKind2 === 'distance_shift') {
        return '苦しさを強めている距離の一点に焦点を当てて整理します';
      }

      if (shiftKind2 === 'repair_shift') {
        return '問題を解決に急ぐ流れから離れ、関係のほどけ方を見つける方向で示します';
      }

      if (shiftKind2 === 'decide_shift') {
        return '結論を急いでいる状態を整理し、まず一つ決めたいことの具体へ絞ります';
      }

      return '焦点が散らばっている状態を、一点に収束させる方向で進めます';
  })();

  const questionForFlow =
    (args.meta as any)?.extra?.question ??
    (args.ctxPack as any)?.question ??
    null;

  const outputPolicyForFlow = questionForFlow?.outputPolicy ?? null;

  const questionsMax2 =
    outputPolicyForFlow?.askBackAllowed === false ||
    shiftKind2 === 'clarify_shift' ||
    shiftKind2 === 'stabilize_shift' ||
    shiftKind2 === 'distance_shift' ||
    shiftKind2 === 'decide_shift' ||
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
              answer_user_meaning: shiftKind2 !== 'decide_shift',
              answer_in_one_shot: shiftKind2 === 'decide_shift',
              first_line_is_core_answer: shiftKind2 === 'decide_shift',
              no_question_back: shiftKind2 === 'decide_shift',
              no_question_end: shiftKind2 === 'decide_shift',
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

// ✅ 置き換え 3) buildNormalChatSlotPlan を関数まるごと差し替え
export function buildNormalChatSlotPlan(args: {
  userText: string;
  laneKey?: LaneKey;
  focusLabel?: string;
  ctxPack?: any;
  meta?: any;
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

  const resolvedAskType =
    String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    '';

  const question =
    (args as any)?.meta?.extra?.question ??
    (args as any)?.ctxPack?.question ??
    null;

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
  } else if ((isClarify(userText) && /[?？]/.test(userText)) || resolvedAskType === 'capability_reask') {
    reason = 'clarify';
    usedClarify = true;
    slots = buildClarify(
      userText,
      laneKeyArg,
      flowDelta,
      flow as any,
      resolvedAskType,
      question,
    );
  } else if (isCompose(userText)) {
    reason = 'compose';
    slots = buildCompose(userText, laneKeyArg, flowDelta);
  } else {
    const d = flow?.delta ? String(flow.delta) : 'FORWARD';
    reason = `flow:${d}`;
    slots = buildFlowReply({
      userText,
      laneKey,
      flow,
      lastUserText,
      focusLabel: args.focusLabel,
      ctxPack: args.ctxPack,
      meta: args.meta,
    });
  }

  const normalized = normalizeSlots(slots);
  if (normalized.length === 0) {
    reason = 'guard:no_slots_after_normalize';
    slots = [
      buildNextHintSlot({
        userText,
        laneKey: laneKeyArg,
        flowDelta: flowDelta ?? 'FORWARD',
      }),
    ];
  } else {
    slots = normalized;
  }

  return {
    kind: 'normal-chat',
    stamp,
    reason: [
      reason,
      usedQuestionSlots ? 'usedQuestionSlots' : null,
      usedClarify ? 'usedClarify' : null,
      `flow:${flowDelta ?? 'FORWARD'}`,
      `recent:${recent.length}`,
      args.ctxPack?.shiftKind ? `shiftKind:${String(args.ctxPack.shiftKind)}` : null,
      args.ctxPack?.resolvedAsk?.askType
        ? `askType:${String(args.ctxPack.resolvedAsk.askType)}`
        : null,
    ]
      .filter(Boolean)
      .join(' / '),
    slotPlanPolicy: 'FINAL',
    slots,
  };
}
