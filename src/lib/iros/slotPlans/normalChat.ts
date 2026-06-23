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
import { resolveReplyMode } from '../conversation/resolveReplyMode';

// ✅ 追加：HowTo/方法質問を「立ち位置」へ変換する slots
import { shouldUseQuestionSlots, buildQuestionSlots } from './QuestionSlots';

// ✅ レーン型（IntentBridgeと同じ定義を使う）
import type { LaneKey, ConcretizeOrigin, CreateMode } from '../intentTransition/intentBridge';

// ✅ SHIFT preset（ルールをここに寄せる）
import { SHIFT_PRESET_C_SENSE_HINT, SHIFT_PRESET_T_CONCRETIZE } from '../language/shiftPresets';
import { resolveImageFirstCreateDomain, resolveImageFirstCreateFocusLabel } from '../create/convergenceAxis';

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

function isRelationshipSignalReadingQuestion(text: string) {
  const t = norm(text);
  if (!t) return false;

  const hasRelationSubject =
    /(相手|その人|あの人|好きな人|気になる人|気になっている人|気になっている相手|片思い|恋愛|恋バナ|脈あり|脈なし)/u.test(t);

  const hasSignalAsk =
    /(脈あり|脈なし|好意|好きなのか|好きなのかな|私を好き|自分を好き|気がある|気があって|探り|恋バナ|ただ聞いて|ただ優しい|どう見れば|どう見る|これは|可能性)/u.test(t);

  const hasQuotedRomanceQuestion =
    /「[^」]{1,40}(好きな人|気になる人|恋人|彼氏|彼女|付き合|好き|恋愛)[^」]{0,40}」/u.test(t);

  const hasRepeatedRomanceAsk =
    /(前に|以前|この前|また|何度か|複数回|ちなみに)/u.test(t) &&
    /(聞いてきた|聞かれた|質問された|言ってきた)/u.test(t) &&
    /(好きな人|気になる人|恋愛|恋バナ|彼氏|彼女)/u.test(t);

  return (hasRelationSubject && hasSignalAsk) || hasQuotedRomanceQuestion || hasRepeatedRomanceAsk;
}
function extractCurrentFocusPersonLabel(text: string): string | null {
  const t = norm(text);
  if (!t) return null;

  const patterns = [
    /今(?:は|の)?([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)のことで見てほしい/u,
    /今(?:は|の)?([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)を見てほしい/u,
    /今(?:気になっている|気になる)([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)/u,
    /今回は([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)/u,
    /([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)の気持ちは/u,
    /([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)のことで見てほしい/u,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) return m[1];
  }

  return null;
}

function extractBackgroundPersonLabels(text: string): string[] {
  const t = norm(text);
  if (!t) return [];

  const labels = new Set<string>();
  const patterns = [
    /前に([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)のことで相談/u,
    /([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)は昔好きだった人/u,
    /([A-Za-zＡ-Ｚａ-ｚ一-龯ぁ-んァ-ヶー]{1,12}さん)は.*今はもう連絡していません/u,
  ];

  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) labels.add(m[1]);
  }

  return Array.from(labels);
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

function isEthicalAbundanceRefusalInput(value: unknown): boolean {
  const t = String(value ?? '').replace(/[ \t\r\n　]/g, '').toLowerCase();
  const hasAiOrBeautifulWords = /ai|きれいごと|綺麗事|きれいな言葉|自由|好きなことで働く|好きなことで稼ぐ|自分の価値/u.test(t);
  const hasMoneyFlow = /儲け|儲か|お金|稼ぐ|売る|売り文句|商売|商品|課金|ビジネス|豊か/u.test(t);
  const hasAnxietyUse = /不安|弱さ|痛み|悩み|刺激|あおる|煽る|つけこむ|つけ込む|見つけて|材料/u.test(t);
  const hasMoralRejection = /だけじゃないですか|同じじゃないですか|変えるだけ|嫌|いや|うんざり|拒否|疑い|警戒|腹が立つ|騙されたくない|雑に扱われたくない|勝手に希望で包まれたくない/u.test(t);
  return hasAiOrBeautifulWords && hasMoneyFlow && hasAnxietyUse && hasMoralRejection;
}

function resolveConcretizeCreateContext(args: {
  userText: string;
  laneKey?: LaneKey | null;
  flowDelta?: string | null;
  ctxPack?: any;
  meta?: any;
}): {
  concretizeOrigin: ConcretizeOrigin;
  createMode: CreateMode;
  createReady: boolean;
  createReason: string;
} {
  const t = norm(args.userText);
  const laneKey = args.laneKey ?? null;
  const ctxPack = args.ctxPack ?? args.meta?.extra?.ctxPack ?? {};
  const meta = args.meta ?? {};

  const flowDelta = String(
    args.flowDelta ??
      ctxPack?.flow?.delta ??
      meta?.extra?.flow?.delta ??
      meta?.flow?.delta ??
      ''
  )
    .trim()
    .toUpperCase();

  const hasTSignal =
    meta?.itTriggered === true ||
    meta?.it_triggered === true ||
    meta?.tLayerModeActive === true ||
    meta?.t_layer_mode_active === true ||
    typeof meta?.tLayerHint === 'string' ||
    typeof meta?.t_layer_hint === 'string' ||
    typeof meta?.tVector === 'string' ||
    typeof meta?.t_vector === 'string' ||
    Boolean(meta?.intentAnchorKey) ||
    Boolean(meta?.intent_anchor_key) ||
    Boolean(meta?.intent_anchor) ||
    Boolean(meta?.intentAnchor) ||
    Boolean(ctxPack?.tcfStarter) ||
    Boolean(ctxPack?.preSeedCreateSignal);

  const isScUnstuck =
    /(じゃあどうしたら|じゃあどうすれば|結局どうしたら|結局どうすれば|もう分からない|もうわからない|もう無理|全部だめ|どうせ|しんどい|疲れた|限界)/u.test(t);

  const isRelationshipRc =
    /(相手|好きな人|あの人|その人|返事|返信|反応|距離|近づ|重い|離れ|嫌われ|不安|確認したい|気持ちが分から|気持ちがわから)/u.test(t);

  if (laneKey === 'T_CONCRETIZE' && hasTSignal) {
    return {
      concretizeOrigin: 'TC_CREATE',
      createMode: 'imaginal_create',
      createReady: true,
      createReason: 't_signal_present',
    };
  }

  if (isScUnstuck) {
    return {
      concretizeOrigin: 'SC_UNSTUCK',
      createMode: 'unstuck_action',
      createReady: false,
      createReason: 'overwhelmed_or_throwaway_howto',
    };
  }

  if (laneKey === 'T_CONCRETIZE' && (flowDelta === 'RETURN' || isRelationshipRc)) {
    return {
      concretizeOrigin: 'RC_STABILIZE',
      createMode: 'stabilize_action',
      createReady: false,
      createReason: isRelationshipRc ? 'relationship_reaction_howto' : 'return_flow_howto',
    };
  }

  return {
    concretizeOrigin: 'GENERAL_ACTION',
    createMode: 'general_action',
    createReady: false,
    createReason: 'general_concretize',
  };
}

// ✅ Phase11: advance判定のための “橋” を必ず出す
// - evidenceLog.ts は key==='NEXT' または content.startsWith('@NEXT_HINT') を検出し、
//   さらに mode==='advance_hint' を拾えれば advance=1 になる。
function buildNextHintSlot(args: {
  userText: string;
  laneKey?: LaneKey | null;
  flowDelta?: string | null;
  memoryRecallCheck?: boolean | null;
  ctxPack?: any;
  meta?: any;
  concretizeOrigin?: ConcretizeOrigin | null;
  createMode?: CreateMode | null;
}): NormalChatSlot {
  const laneKey = safeLaneKey(args.laneKey);
  const delta = args.flowDelta ? String(args.flowDelta) : null;
  const memoryRecallCheck = args.memoryRecallCheck === true;

  if (memoryRecallCheck) {
    return {
      key: 'NEXT',
      role: 'assistant',
      style: 'neutral',
      content: `@NEXT_HINT ${JSON.stringify({
        mode: 'memory_recall_not_found_hint',
        laneKey: laneKey ?? null,
        delta,
        hint: '記憶検索で見つかっていない事実を返す',
        message: '覚えているふりをせず、別の手がかりがあれば探し直せると伝える。',
      })}`,
    };
  }

  const createCtx =
    laneKey === 'T_CONCRETIZE'
      ? resolveConcretizeCreateContext({
          userText: args.userText,
          laneKey,
          flowDelta: delta,
          ctxPack: args.ctxPack,
          meta: args.meta,
        })
      : null;

  const concretizeOrigin =
    args.concretizeOrigin ??
    createCtx?.concretizeOrigin ??
    null;

  const createMode =
    args.createMode ??
    createCtx?.createMode ??
    null;

  const mode =
    laneKey === 'T_CONCRETIZE'
      ? createMode === 'imaginal_create'
        ? 'imaginal_create_hint'
        : createMode === 'stabilize_action'
          ? 'rc_stabilize_hint'
          : createMode === 'unstuck_action'
            ? 'sc_unstuck_hint'
            : 'general_action_hint'
      : 'resonance_hint';

  const hint =
    laneKey === 'T_CONCRETIZE'
      ? concretizeOrigin === 'TC_CREATE'
        ? '内部指示を本文に出さず、文脈に合う自然な一歩だけを返す。'
        : concretizeOrigin === 'RC_STABILIZE'
          ? '相手の反応を取りに行かず、不安で動くのか自然に差し出せるのかを分ける。送るなら短い一言、薄ければ重ねない。'
          : concretizeOrigin === 'SC_UNSTUCK'
            ? '全部を決めさせず、負荷を下げる。今日見る一点だけに絞り、すぐ行動させない。'
            : '一つだけ実行可能な入口を出し、判断条件を添える。'
      : laneKey === 'IDEA_BAND'
        ? '候補を増やさず、いま出ている差だけを見やすくする'
        : 'いま触れている輪郭を、説明へ戻さずそのまま残す';

  const message =
    laneKey === 'T_CONCRETIZE'
      ? concretizeOrigin === 'TC_CREATE'
        ? '次は形象で終わらず、現実へ置ける入口まで作る。'
        : concretizeOrigin === 'RC_STABILIZE'
          ? '次は抽象的な形ではなく、不安で動くか自然に差し出すかの判断線を出す。'
          : concretizeOrigin === 'SC_UNSTUCK'
            ? '次は答えを増やさず、まず負荷を下げて一点だけ見る。'
            : '次は具体を一つだけ出す。'
      : laneKey === 'IDEA_BAND'
        ? '次は候補を増やすより、いま出ている差だけを見やすくするのが合っています。'
        : '次へ進めるより、いま残っている感触をそのまま置く';

  return {
    key: 'NEXT',
    role: 'assistant',
    style: 'neutral',
    content: `@NEXT_HINT ${JSON.stringify({
      mode,
      laneKey: laneKey ?? null,
      delta,
      concretizeOrigin,
      createMode,
      createReady: createCtx?.createReady ?? false,
      createReason: createCtx?.createReason ?? null,
      hint: clamp(hint, 120),
      message: clamp(message, 160),
    })}`,
  };


}

function buildSafeSlot(args: { reason?: string | null; laneKey?: LaneKey | null; flowDelta?: string | null }): NormalChatSlot {
  const laneKey = safeLaneKey(args.laneKey);
  const delta = args.flowDelta ? String(args.flowDelta) : null;

  const reasonText = args.reason ? clamp(norm(args.reason), 120) : null;

  const message =
    reasonText
      ? reasonText
      : delta === 'RETURN'
        ? 'これは後退ではなく、芯を取り直すための戻りです。'
        : delta === 'SWITCH'
          ? '無理に前の形へ戻す必要はなく、見え方が変わること自体は自然な移行です。'
          : 'ここで急いで結論を増やさなくても、流れそのものは崩れていません。';

  return {
    key: 'SAFE',
    role: 'assistant',
    style: 'soft',
    content: m('SAFE', {
      laneKey: laneKey ?? null,
      delta,
      reason: reasonText,
      message,
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
  return /(文章|文面|例文|使える文|返信文|LINE文|ライン文|送る文|送信文|返す文|返事文|文ください|文をください|文を作って|書いて|まとめて)/.test(t);
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
          questions_max: 0,
          no_question_back: true,
          no_question_end: false,
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
  resolvedAskArg?: any,
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

  const resolvedAskTopic = String((resolvedAskArg as any)?.topic ?? '').trim();
  const resolvedAskSourceUserText = String((resolvedAskArg as any)?.sourceUserText ?? '').trim();

  const seedText = clamp(
    norm(resolvedAskTopic || userText),
    240
  );

  const instructionText = clamp(
    norm(resolvedAskSourceUserText || userText),
    240
  );

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

  const asksMemoryRecallCheck =
    /(覚えて|覚えてる|覚えていますか|覚えてますか|前に話した|以前話した|前話した|この前話した|あの話|その話|続き)/u.test(instructionText) &&
    /(話|こと|件|覚えて|覚えてる|覚えていますか|覚えてますか)/u.test(instructionText);

  const shouldMemoryRecallCheck =
    !isT &&
    asksMemoryRecallCheck;

  const usePastReframe = !!outputPolicy?.usePastReframe;
  const splitFactHypothesis = !!outputPolicy?.splitFactHypothesis;
  const avoidPrematureClosure = !!outputPolicy?.avoidPrematureClosure;

  const questionSuggestsTruthStructure =
    questionType === 'truth';

  const questionSuggestsPastReframe =
    !shouldMemoryRecallCheck &&
    (
      questionType === 'unresolved_release' ||
      tMode === 'reobserve_past' ||
      usePastReframe
    );

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
      line: '',
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

    const normalizedUserText = norm(instructionText);
    const normalizedTargetText = norm(seedText);

    const resolvedAskType: string = (() => {
      const stamped = String(resolvedAskTypeArg ?? '').trim();

      const looksTruthStructure =
        (
          /(地球外生命体|宇宙人)/.test(normalizedTargetText) &&
          /(人間|人類)/.test(normalizedTargetText) &&
          /(作った|作られた|介入)/.test(normalizedTargetText) &&
          /(構造)/.test(normalizedUserText + normalizedTargetText)
        ) ||
        (
          !!resolvedAskTopic &&
          stamped === 'truth_structure'
        );

      if (stamped) return stamped;
      return looksTruthStructure ? 'truth_structure' : '';
    })();

    console.log('[IROS/NORMAL_CHAT][BUILD_CLARIFY_TRACE]', {
      userHead: String(userText ?? '').slice(0, 80),
      resolvedAskTypeArg: String(resolvedAskTypeArg ?? ''),
      resolvedAskType,
      lane,
      isT,
      normalizedUserText: normalizedUserText.slice(0, 120),
      normalizedTargetText: normalizedTargetText.slice(0, 160),
      resolvedAskTopic: resolvedAskTopic || null,
      resolvedAskSourceUserText: resolvedAskSourceUserText || null,
      instructionText: instructionText || null,
      questionType,
      tMode,
      questionFocus: questionFocus || null,
      usePastReframe,
      splitFactHypothesis,
      avoidPrematureClosure,
    });

  const directAnswerRequested =
    /答え|結論|要するに|真実が知りたい|本当のことが知りたい|そろそろ結論|今の未来|未来だよ/.test(seedText);
    const hasTruthStructureLexeme =
    /(真実|事実|本当|構造|論点|検証|仮説|どこまで言える|切り分け|整理)/.test(normalizedUserText) ||
    (
      /(地球外生命体|宇宙人)/.test(normalizedUserText) &&
      /(人間|人類)/.test(normalizedUserText) &&
      /(作った|作られた|介入)/.test(normalizedUserText)
    );    const isStructureQuestion = questionType === 'structure';
    const isTruthQuestion = questionType === 'truth';    const shouldRelationshipSignalReading =
      isRelationshipSignalReadingQuestion(instructionText) ||
      isRelationshipSignalReadingQuestion(seedText) ||
      isRelationshipSignalReadingQuestion(normalizedUserText) ||
      isRelationshipSignalReadingQuestion(normalizedTargetText);

    const currentFocusPersonLabel =
      extractCurrentFocusPersonLabel(instructionText) ||
      extractCurrentFocusPersonLabel(seedText) ||
      extractCurrentFocusPersonLabel(normalizedUserText) ||
      extractCurrentFocusPersonLabel(normalizedTargetText);

    const backgroundPersonLabels = Array.from(
      new Set([
        ...extractBackgroundPersonLabels(instructionText),
        ...extractBackgroundPersonLabels(seedText),
        ...extractBackgroundPersonLabels(normalizedUserText),
        ...extractBackgroundPersonLabels(normalizedTargetText),
      ]),
    ).filter((label) => label !== currentFocusPersonLabel);

    // 恋愛サイン判定は、T_CONCRETIZE / IMAGE_FIRST_CREATE に吸わせない
    const isTForClarify = isT && !shouldRelationshipSignalReading;

    const shouldAnswerTruthStructure =
      resolvedAskType === 'truth_structure' ||
      isTruthQuestion ||
      isStructureQuestion ||
      (questionSuggestsTruthStructure && hasTruthStructureLexeme);

    const shouldReanswerCapability =
      resolvedAskType === 'capability_reask';

    const shiftIntentBase =
      shouldRelationshipSignalReading
        ? 'relationship_signal_reading'
        : isTForClarify
          ? 'place_imaginal_form'
          : shouldMemoryRecallCheck
          ? 'memory_recall_check'
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
      shouldRelationshipSignalReading
        ? 'relationship_signal_reading_v1'
        : isTForClarify
          ? 'image_first_create_v1'
          : shouldReanswerCapability
          ? 'repair_capability_reask_v1'
          : shouldAnswerTruthStructure
            ? 'clarify_truth_structure_v1'
            : directAnswerRequested
              ? 'decide_shift_v1'
              : 'clarify_meaning_v1';

              const wantsResonanceStructureReading =
                shouldAnswerTruthStructure &&
                (
                  /(共鳴|響き|象徴|構造)/u.test(instructionText) ||
                  /(共鳴|響き|象徴|構造)/u.test(resolvedAskSourceUserText)
                );

              const shiftLineBase =
              shouldRelationshipSignalReading
                ? '相手の恋愛質問は、脈あり断定ではなく、探り・恋バナ・好意確認の三つに分けて読む'
                : isTForClarify
                  ? '相手の反応待ちから、自分の時間を先に戻す形'
                  : shouldMemoryRecallCheck
                  ? '過去の記憶参照が取れるかを確認している'
                  : questionSuggestsPastReframe
                    ? '未完了の感じが、まだ戻ってきている'
                    : shouldReanswerCapability
                      ? 'できることの輪郭だけが、先に立っている'
                      : directAnswerRequested
                        ? '答えの芯だけが、先に出ている'
                        : shouldAnswerTruthStructure
                          ? wantsResonanceStructureReading
                            ? '事実確認だけで閉じず、対象に響いている象徴構造と関係構造を読む'
                            : '中心にある論点を、固定文や余韻の決め台詞にせず、ユーザーの発話に沿った日常語で明確にする'
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
                    kind: isTForClarify ? 't_concretize' : 'clarify',
                    intent: shiftIntentBase,
                    hint: shiftHintBase,
                    line: shiftLineBase,
                    source: shouldRelationshipSignalReading
                      ? 'relationship_signal_reading'
                      : isTForClarify
                        ? 'create_progress_bridge'
                        : shouldMemoryRecallCheck
                        ? 'memory_recall'
                        : questionSuggestsPastReframe
                          ? 'question_engine'
                          : shouldAnswerTruthStructure
                            ? 'resolved_ask'
                            : shouldReanswerCapability
                              ? 'resolved_ask'
                              : clarifyMeaning.source,
                    meaning_kind: shouldRelationshipSignalReading
                      ? 'relationship_signal_reading'
                      : isTForClarify
                        ? null
                        : shouldMemoryRecallCheck
                        ? 'memory_recall_check'
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
                    contract: shouldRelationshipSignalReading
                      ? ['answer_first', 'no_user_echo', 'no_image_first_create', 'split_signal_possibilities', 'no_mind_reading', 'current_focus_target_first', 'plain_words']
                      : isTForClarify
                        ? ['first_line_is_core', 'one_next_step', 'plain_words']
                        : shouldMemoryRecallCheck
                        ? ['answer_in_one_shot', 'memory_result_required', 'no_memory_claim_without_source', 'plain_words']
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
                                    ...((shouldRelationshipSignalReading ? null : shiftPreset)?.rules ?? {}),
                                    relationship_signal_reading: shouldRelationshipSignalReading
                                      ? {
                                          current_focus_target: currentFocusPersonLabel,
                                          background_targets: backgroundPersonLabels,
                                          must_start_from_current_focus_target: Boolean(currentFocusPersonLabel),
                                          do_not_answer_background_target_first: backgroundPersonLabels.length > 0,
                                          first_line: '今の情報だけでは断定できないが、恋愛状況を複数回聞くのは弱〜中程度の関心シグナル',
                                          split: ['探り', '恋バナ', '自分への好意確認'],
                                          observe: '相手が自分の恋愛話を出すか、会う流れにするかを見る',
                                          no_user_echo: true,
                                          no_image_first_create: true,
                                          no_mind_reading: true,
                                        }
                                      : null,
                                    answer_user_meaning:
                                      !shouldMemoryRecallCheck &&
                                      !questionSuggestsPastReframe &&
                                      !shouldAnswerTruthStructure &&
                                      !shouldReanswerCapability,
                                    answer_truth_structure: shouldAnswerTruthStructure,
                                    memory_recall_check: shouldMemoryRecallCheck,
                                    use_past_reframe: questionSuggestsPastReframe,
                                    no_flow_lecture: true,
                                    no_meta_explain: true,
                                    output_only:
                                      shouldAnswerTruthStructure ||
                                      shouldReanswerCapability ||
                                      clarifyMeaning.kind === 'topic_recall' ||
                                      isDefinitionQuestion ||
                                      isMeaningConfirm,
                                    // ✅ Markdown許可:
                                    // writer guard の WG:BULLETS を止める
                                    // output_only は維持しつつ、箇条書き・見出し・区切り線を許可する
                                    no_bullets: false,
                                    lines_max:
                                    shouldAnswerTruthStructure
                                      ? 4
                                      : shouldReanswerCapability
                                        ? 3
                                        : clarifyMeaning.kind === 'topic_recall'
                                          ? 3
                                          : isDefinitionQuestion
                                            ? 4
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
                              buildNextHintSlot({
                                userText,
                                laneKey: lane,
                                flowDelta: delta,
                                memoryRecallCheck: shouldMemoryRecallCheck,
                              }),
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
   * - 添え候補 2本
   * - 推し 1本
   * - 合計3行
   * - 説明しない / 理由を書かない / 質問しない
   * ==================================================
   */
  const lineCount = 3;

  return m('SHIFT', {
    kind: 'idea_band',
    intent: 'spotlight_one',
    hint: 'idea_band_spotlight_v1',
    rules: {
      ...SHIFT_PRESET_C_SENSE_HINT.rules,
      candidates_min: lineCount,
      candidates_max: lineCount,
      lines_max: lineCount,
      support_candidates: 2,
      spotlight_candidates: 1,
      questions_max: 0,
      no_question_back: true,
      no_question_end: true,
      no_decision: false,
      no_action_commit: true,
      no_lecture: true,
      no_future_instruction: true,
      no_checklist: true,
      no_explanation: true,
      no_reason: true,
      mode: 'spotlight',
      spotlight_last_line: true,
      spotlight_label: '🌀 推し',
      spotlight_style: 'confident_hypothesis',
    },
    tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,
    allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), short_reply_ok: false },
    format: {
      lines: lineCount,
      schema: ['support_candidate_line', 'support_candidate_line', 'spotlight_line_with_label'],
      line_contract: 'two_support_candidates_then_one_spotlight',
    },
    seed_text: clamp(seedText, 240),
  });
}


// --- 置き換え 1) buildShiftTConcretize を関数まるごと置き換え ---
function buildImageFirstCreateSlots(args: { userText: string; ctxPack?: any; meta?: any; flowDelta?: string | null }): NormalChatSlot[] {
  const ctxPack = args.ctxPack ?? args.meta?.extra?.ctxPack ?? {};
  const domain = ctxPack.focusDomain ?? ctxPack.tcfStarter?.focusDomain ?? resolveImageFirstCreateDomain({ userText: args.userText, relationshipContext: ctxPack.relationshipContext, relationshipCapture: ctxPack.relationshipCapture, resolvedRelationId: ctxPack.resolvedRelationId, targetLabel: ctxPack.targetLabel, activeDiagnosisFrame: ctxPack.activeDiagnosisFrame, topicDigest: ctxPack.topicDigest, situationTopic: ctxPack.situationTopic, cognitionMap: ctxPack.cognitionMap });
  const line = ctxPack.focusLabel ?? ctxPack.tcfStarter?.currentFocus ?? ctxPack.tcfStarter?.nextFocus ?? resolveImageFirstCreateFocusLabel(domain);

  const relationImageFirstSource = [
    args.userText,
    line,
    ctxPack.targetLabel,
    ctxPack.relationshipContext,
    ctxPack.relationshipCapture,
    ctxPack.preSeedWriterSeed,
    ctxPack.preSeedWriterGuidance,
  ].filter(Boolean).join('\n');

  if (/(相手|好きな人|気になっている相手|片思い|恋愛|返事|返信|反応|距離|近づ|重い|嫌われ|不安|気持ちが分から|気持ちがわから)/u.test(relationImageFirstSource)) {
    return [
      { key: 'SHIFT', role: 'assistant', style: 'neutral', content: buildShiftTConcretize([args.userText, line].filter(Boolean).join('\n'), line) },
    ];
  }
  return [
    { key: 'OBS', role: 'assistant', style: 'soft', content: m('OBS', { laneKey: 'T_CONCRETIZE', createAxis: 'imaginal_form_create', focusDomain: domain, user: null }) },
    { key: 'SHIFT', role: 'assistant', style: 'neutral', content: m('SHIFT', { kind: 't_concretize', intent: 'place_imaginal_form', hint: 'image_first_create_v1', line, source: 'tcf_rotation', createAxis: 'imaginal_form_create', focusDomain: domain, writerPattern: 'IMAGE_FIRST_CREATE_V1', contract: ['first_line_places_imaginal_form', 'no_action_plan', 'no_message_draft', 'no_checklist', 'plain_words'], rules: { no_action_plan: true, no_message_draft: true, no_send_decision: true, no_checklist: true, no_bullets: true, questions_max: 0, lines_max: 4, forbidden_words: ['紙に書く', 'メモする', '一つに絞る', '短く送る', '送るなら', '送るか送らないか', '一通', '文面', '返信', '返事', '連絡'] }, seed_text: ['形象：' + line, '出力ルール：行動案・文案例・送る/送らない判断を冒頭に出さない。', 'まず内側に置く形を一つ提示し、その意味を短く説明する。', '最後に必要なら、その形を崩さない小さな保持だけを添える。'].join('\n') }) },
    { key: 'NEXT', role: 'assistant', style: 'neutral', content: '@NEXT_HINT ' + JSON.stringify({
      mode: 'imaginal_create_hint',
      laneKey: 'T_CONCRETIZE',
      delta: args.flowDelta ?? null,
      concretizeOrigin: 'TC_CREATE',
      createMode: 'imaginal_create',
      createReady: true,
      createReason: 'image_first_create_slots',
      hint: '内部指示を本文に出さず、文脈に合う自然な一歩だけを返す。',
      message: '次は内部指示を出さず、自然な一歩だけを返す。'
    }) },
  ];
}

function buildShiftTConcretize(seedText: string, focusLabel?: string) {
  const focus = typeof focusLabel === 'string' && focusLabel.trim() ? focusLabel.trim() : '';
  const raw = String(seedText ?? '').trim();
  const source = `${focus}\n${raw}`;

  const isRelationshipRc =
    /(相手|好きな人|あの人|その人|返事|返信|反応|距離|近づ|重い|離れ|嫌われ|不安|確認したい|気持ちが分から|気持ちがわから)/u.test(source);

  const isScUnstuck =
    /(じゃあどうしたら|じゃあどうすれば|結局どうしたら|結局どうすれば|もう分からない|もうわからない|もう無理|全部だめ|どうせ|しんどい|疲れた|限界)/u.test(source);

  const isTcCreate =
    /PRESEED_CREATE_DIRECTIVE_FORCE|image_first_create|place_create|TC_CREATE|imaginal_create/u.test(source);

  // 恋愛・相手反応・不安文脈では、Createより確率フロー/安定化を優先する。
  // 「どうしたらいい？」は新しい形象を作るより、
  // 直前の良い流れを次の一歩へ変換する方が自然。
  const origin = isRelationshipRc
    ? 'RC_STABILIZE'
    : isScUnstuck
      ? 'SC_UNSTUCK'
      : isTcCreate
        ? 'TC_CREATE'
        : 'GENERAL_ACTION';

  const mode = origin === 'TC_CREATE'
    ? 'imaginal_create'
    : origin === 'RC_STABILIZE'
      ? 'stabilize_action'
      : origin === 'SC_UNSTUCK'
        ? 'unstuck_action'
        : 'general_action';

  const focusLine =
    focus ||
    (origin === 'RC_STABILIZE'
      ? '不安で動くか、自然に一言だけ差し出せるか'
      : origin === 'SC_UNSTUCK'
        ? '今すぐ全部を決めず、一点だけ見ること'
        : origin === 'TC_CREATE'
          ? '今の文脈で現実に置く入口'
          : '今できる具体を一つに絞ること');

  const writerSeed =
    origin === 'RC_STABILIZE'
      ? [
          focus ? `対象：${focus}` : '',
          raw ? `状況：${raw}` : '',
          '出力ルール：抽象語で終わらない。「形」「中心」「立ち位置」「戻りたい現実のイメージ」を最終出力に使わない。',
          '目的：直前の良い流れを、確率の高い次の一歩として本文化する。相手の気持ちを当てに行かず、不安で動くのか自然に一言だけ差し出せるのかを分ける。',
          '必須：送るなら短い一言。返事が薄ければ重ねない。相手が広げてきたら少しだけ返す。見るのは相手の気持ちの断定ではなく、返ってくる温度。',
          '形式：3〜6行。箇条書き禁止。質問で終わらない。内部指示やseed文を本文に出さない。',
        ].filter(Boolean).join('\n')
      : origin === 'SC_UNSTUCK'
        ? [
            focus ? `対象：${focus}` : '',
            raw ? `状況：${raw}` : '',
            '出力ルール：全部を決めさせない。行動リストにしない。まず負荷を下げる。',
            '必須：今日見る一点だけを出す。すぐ相手に答えを取りに行かせない。',
            '形式：3〜5行。箇条書き禁止。質問で終わらない。',
          ].filter(Boolean).join('\n')
        : origin === 'TC_CREATE'
          ? [
              focus ? `対象：${focus}` : '',
              raw ? `状況：${raw}` : '',
              '出力ルール：内部指示を本文に出さない。本文では、文脈に合う自然な一歩だけを書く。',
              '禁止：内部指示の復唱。抽象語だけで終わること。行動リスト化すること。',
              '形式：3〜6行。箇条書き禁止。',
            ].filter(Boolean).join('\n')
          : [
              focus ? `対象：${focus}` : '',
              raw ? `状況：${raw}` : '',
              '出力ルール：一つだけ実行可能な入口を出し、判断条件を添える。',
              '形式：2〜5行。箇条書き禁止。',
            ].filter(Boolean).join('\n');

  console.warn('[IROS/T_CONCRETIZE][SHIFT_BUILDER_USED]', {
    origin,
    mode,
    hasFocus: !!focus,
    seedHead: writerSeed.slice(0, 120),
    stack: new Error('SHIFT_BUILDER_USED').stack,
  });

  const payload = {
    kind: 't_concretize',
    intent: origin === 'TC_CREATE' ? 'place_imaginal_form' : mode,
    hint:
      origin === 'TC_CREATE'
        ? 'tc_create_v1'
        : origin === 'RC_STABILIZE'
          ? 'rc_stabilize_v1'
          : origin === 'SC_UNSTUCK'
            ? 'sc_unstuck_v1'
            : 'general_action_v1',
    line: focusLine,
    source: 'create_origin_bridge',
    concretizeOrigin: origin,
    createMode: mode,
    createReady: origin === 'TC_CREATE',
    createAxis:
      origin === 'TC_CREATE'
        ? 'imaginal_form_create'
        : origin === 'RC_STABILIZE'
          ? 'stabilize_action'
          : origin === 'SC_UNSTUCK'
            ? 'unstuck_action'
            : 'general_action',
    rules: {
      ...(SHIFT_PRESET_T_CONCRETIZE.rules ?? {}),
      no_checklist: true,
      no_lecture: true,
      no_future_instruction: origin !== 'TC_CREATE',
      questions_max: 0,
      no_question_back: true,
      no_question_end: true,
      require_focus_line: false,
    },
    seed_text: writerSeed,
    tone: SHIFT_PRESET_T_CONCRETIZE.tone ?? undefined,
    allow: {
      ...(SHIFT_PRESET_T_CONCRETIZE.allow ?? {}),
      concrete_reply: origin !== 'TC_CREATE',
      short_reply_ok: origin !== 'TC_CREATE',
    },
  };

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
  const preSeedFlowDirectiveNow =
    (args as any)?.ctxPack?.preSeedFlowDirective ??
    (args as any)?.meta?.extra?.ctxPack?.preSeedFlowDirective ??
    (args as any)?.meta?.preSeedFlowDirective ??
    null;
  const hiddenQuestionLandingNow =
    isEthicalAbundanceRefusalInput(args.userText) ||
    (args as any)?.ctxPack?.hiddenQuestionLanding === true ||
    (args as any)?.meta?.extra?.ctxPack?.hiddenQuestionLanding === true ||
    (args as any)?.meta?.extra?.hiddenQuestionLanding === true ||
    preSeedFlowDirectiveNow?.intentionConvergence?.answerHiddenQuestion === true ||
    preSeedFlowDirectiveNow?.intentionConvergence?.shouldLandHiddenQuestion === true ||
    preSeedFlowDirectiveNow?.writerGuidance?.shouldLandHiddenQuestion === true;
  const hiddenQuestionLandingKindNow =
    isEthicalAbundanceRefusalInput(args.userText) ||
    (args as any)?.ctxPack?.ethicalAbundanceRefusal === true ||
    (args as any)?.meta?.extra?.ctxPack?.ethicalAbundanceRefusal === true
      ? 'ethical_abundance_refusal'
      : 'intention_refusal';
  const createAxisNow = String((args as any)?.ctxPack?.createAxis ?? '').trim() || String((args as any)?.ctxPack?.targetKind ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.createAxis ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.cDirection ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.createAxis ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.targetKind ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.createAxis ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.cDirection ?? '').trim();
  const writerPatternNow = String((args as any)?.ctxPack?.writerPatternKey ?? '').trim() || String((args as any)?.ctxPack?.tcfStarter?.writerPatternKey ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.writerPatternKey ?? '').trim() || String((args as any)?.meta?.extra?.ctxPack?.tcfStarter?.writerPatternKey ?? '').trim();
  if (createAxisNow === 'imaginal_form_create' || writerPatternNow === 'IMAGE_FIRST_CREATE_V1') {
    return buildImageFirstCreateSlots({ userText: args.userText, ctxPack: args.ctxPack, meta: args.meta, flowDelta: args.flow?.delta ?? null });
  }

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

    const replyDecisionBase = resolveReplyMode({
      userText: args.userText,
      resolvedAskType:
        String((args as any)?.resolvedAskType ?? '').trim() ||
        String((args as any)?.ctxPack?.resolvedAskType ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.resolvedAskType ?? '').trim() ||
        '',
      shiftKind:
        String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||
        '',
      stampedShiftKind:
        String((args as any)?.ctxPack?.stampedShiftKind ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.stampedShiftKind ?? '').trim() ||
        '',
      goalKind:
        String((args as any)?.ctxPack?.goalKind ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.goalKind ?? '').trim() ||
        '',
      replyGoal:
        String((args as any)?.ctxPack?.replyGoal ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.replyGoal ?? '').trim() ||
        '',
      laneKey:
        String((args as any)?.ctxPack?.laneKey ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.laneKey ?? '').trim() ||
        '',
      targetKind:
        String((args as any)?.ctxPack?.targetKind ?? '').trim() ||
        String((args as any)?.meta?.extra?.ctxPack?.targetKind ?? '').trim() ||
        '',
      topicDigest:
        (args as any)?.ctxPack?.topicDigest ??
        (args as any)?.meta?.extra?.ctxPack?.topicDigest ??
        null,
      topicDigestV2:
        (args as any)?.ctxPack?.topicDigestV2 ??
        (args as any)?.meta?.extra?.ctxPack?.topicDigestV2 ??
        null,
      conversationLine:
        (args as any)?.ctxPack?.conversationLine ??
        (args as any)?.meta?.extra?.ctxPack?.conversationLine ??
        null,
    });

    const laneKeyForObs: LaneKey | null =
      replyDecisionBase?.laneKey === 'T_CONCRETIZE' || replyDecisionBase?.laneKey === 'IDEA_BAND'
        ? replyDecisionBase.laneKey
        : useTConcretize
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

  console.log('[IROS/NORMAL_CHAT][SHIFT_INPUTS_REAL]', {
    stampedShiftKind:
      String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||
      '',
    resolvedAskType:
      String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
      '',
    goalKind_metaExtra:
      String((args as any)?.meta?.extra?.goalKind ?? '').trim() ||
      '',
    goalKind_ctxPack:
      String((args as any)?.ctxPack?.goalKind ?? '').trim() ||
      '',
    targetKind:
      String((args as any)?.targetKind ?? '').trim() ||
      '',
    hasCtxPack: !!(args as any)?.ctxPack,
    hasMeta: !!(args as any)?.meta,
    userHead: String(args.userText ?? '').slice(0, 60),
    typeof_userText: typeof args.userText,
  });

  const shiftKind2 = (() => {
    const userTextNow2 = String(args.userText ?? '').trim();

    const hasConvergeSignal2 =
      hasAny(
        '決めたい',
        '決めます',
        '決めた',
        '結論を出したい',
        '結論を出す',
        '結論が欲しい',
        '一つに絞りたい',
        'そろそろ決めたい',
        '決断したい',
        'もう決める',
      ) ||
      /(やめるべきか|行くべきか|どちらにするか|どっちにするか)/.test(userTextNow2);

    const stampedShiftKind =
      String((args as any)?.ctxPack?.shiftKind ?? '').trim() ||
      String((args as any)?.meta?.extra?.ctxPack?.shiftKind ?? '').trim() ||
      '';

      const directAnswerRequested2 = hasAny(
        '答え',
        '結論',
        '要するに',
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

    const rawTextNow = String(t ?? '').trim();
    const compactTextNow = rawTextNow.replace(/\s+/g, '');
    const textLenNow = compactTextNow.length;

    const styleResonateOverride =
      hasAny(
        'もっと共鳴',
        '共鳴して',
        '枠を外して',
        '枠から外れて',
        '一般的な回答をしないで',
        'そのまま返して',
        '会話にして',
        '会話語',
        'コードからも外れて',
        '説明になっちゃう',
        '説明だよ'
      ) ||
      /(もっと共鳴|共鳴して|枠を外して|枠から外れて|一般的な回答をしないで|そのまま返して|会話にして|会話語|コードからも外れて|説明になっちゃう|説明だよ)/.test(rawTextNow);

      const isClarifyLike =
      !styleResonateOverride &&
      (
        isClarify(t) ||
        resolvedAskType === 'truth_structure' ||
        String(
          (args as any)?.ctxPack?.question?.questionType ??
            (args as any)?.meta?.extra?.ctxPack?.question?.questionType ??
            (args as any)?.meta?.extra?.question?.questionType ??
            ''
        ).trim() === 'structure' ||
        /構造|構造的|仕組み|関係|違い|配置|流れ|構成/.test(String(t ?? '')) ||
        resolvedAskType === 'meaning' ||
        resolvedAskType === 'definition' ||
        resolvedAskType === 'topic_clarify'
      );

    const isReturnFlow = String(delta ?? '').trim().toUpperCase() === 'RETURN';

    const isShortAmbiguousFollowup =
      textLenNow <= 18 &&
      (
        hasAny(
          'それ',
          'これ',
          'あれ',
          'そのこと',
          'でも',
          'どう',
          'どっち',
          '違うかも',
          'たぶん'
        ) ||
        /^(それ|これ|あれ|でも|どう|どっち)/.test(compactTextNow)
      );

    const hasConcreteContinuationSignal =
      hasAny(
        '仕事',
        '人間関係',
        '恋愛',
        '結婚',
        '相手',
        '会社',
        '転職',
        '辞める',
        '続ける',
        '未来',
        'お金',
        '不安',
        '揺れてる',
        '迷ってる',
        '変えたい',
        'このままでいい'
      ) ||
      textLenNow >= 19;

    const suppressClarifyShift =
      styleResonateOverride ||
      (
        isReturnFlow &&
        !isShortAmbiguousFollowup &&
        hasConcreteContinuationSignal
      );

    const transcendResonanceOverride =
      hasAny(
        '考えないで',
        '共鳴だけ',
        '枠を超えて',
        '枠を越えて',
        '超えて',
        'あなたが超える',
        'あなたの言葉で',
        '解き放て',
        '解放して'
      ) ||
      /(考えないで|共鳴だけ|枠を[超越]えて|超えて|あなたが超える|あなたの言葉で|解き放て|解放して)/.test(rawTextNow);

    const goalKind2Raw =
      transcendResonanceOverride
        ? 'uncover'
        : styleResonateOverride
          ? 'resonate'
          : String(replyDecisionBase?.goalKind ?? '').trim() ||
            String((args as any)?.ctxPack?.goalKind ?? '').trim() ||
            String((args as any)?.meta?.extra?.ctxPack?.goalKind ?? '').trim() ||
            '';

    const goalKind2 =
      goalKind2Raw === 'clarify' ||
      goalKind2Raw === 'stabilize' ||
      goalKind2Raw === 'decide' ||
      goalKind2Raw === 'resonate' ||
      goalKind2Raw === 'uncover'
        ? goalKind2Raw
        : 'uncover';

        const stampShiftMeta = (
          shiftKind:
            | 'clarify_shift'
            | 'stabilize_shift'
            | 'distance_shift'
            | 'repair_shift'
            | 'decide_shift'
            | 'narrow_shift',
          extras?: {
            goalKind?:
              | 'clarify'
              | 'stabilize'
              | 'decide'
              | 'resonate'
              | 'uncover'
              | 'narrow'
              | null;
            targetKind?:
              | 'clarify'
              | 'stabilize'
              | 'decide'
              | 'resonate'
              | 'uncover'
              | 'narrow'
              | null;
            laneKey?: 'T_CONCRETIZE' | 'IDEA_BAND' | null;
            replyGoalKind?:
              | 'clarify'
              | 'stabilize'
              | 'decide'
              | 'resonate'
              | 'uncover'
              | 'narrow'
              | null;
          },
    ) => {
      const shiftHint =
        shiftKind === 'clarify_shift'
          ? (resolvedAskType === 'truth_structure' ? 'clarify_truth_structure_v1' : 'clarify_meaning_v2')
          : shiftKind === 'stabilize_shift'
            ? 'stabilize_shift_v1'
            : shiftKind === 'distance_shift'
              ? 'distance_shift_v1'
              : shiftKind === 'repair_shift'
                ? 'repair_shift_v1'
                : shiftKind === 'decide_shift'
                  ? 'decide_shift_v1'
                  : 'narrow_shift_v1';

      const shiftIntent =
        shiftKind === 'clarify_shift'
          ? (resolvedAskType === 'truth_structure' ? 'answer_truth_structure' : 'meaning_reframe')
          : shiftKind === 'stabilize_shift'
            ? 'stabilize_direction'
            : shiftKind === 'distance_shift'
              ? 'distance_tuning'
              : shiftKind === 'repair_shift'
                ? 'repair_entry'
                : shiftKind === 'decide_shift'
                  ? 'answer_in_one_shot'
                  : 'narrow_focus';

      try {
        if ((args as any)?.ctxPack) {
          (args as any).ctxPack.shiftKind = shiftKind;
          (args as any).ctxPack.shiftHint = shiftHint;
          (args as any).ctxPack.shiftIntent = shiftIntent;

          if (extras?.goalKind) (args as any).ctxPack.goalKind = extras.goalKind;
          if (extras?.targetKind) (args as any).ctxPack.targetKind = extras.targetKind;
          if (extras?.laneKey !== undefined) (args as any).ctxPack.laneKey = extras.laneKey;
          if (extras?.replyGoalKind) (args as any).ctxPack.replyGoal = { kind: extras.replyGoalKind };
        }

        if ((args as any)?.meta?.extra?.ctxPack) {
          (args as any).meta.extra.ctxPack.shiftKind = shiftKind;
          (args as any).meta.extra.ctxPack.shiftHint = shiftHint;
          (args as any).meta.extra.ctxPack.shiftIntent = shiftIntent;

          if (extras?.goalKind) (args as any).meta.extra.ctxPack.goalKind = extras.goalKind;
          if (extras?.targetKind) (args as any).meta.extra.ctxPack.targetKind = extras.targetKind;
          if (extras?.laneKey !== undefined) (args as any).meta.extra.ctxPack.laneKey = extras.laneKey;
          if (extras?.replyGoalKind) (args as any).meta.extra.ctxPack.replyGoal = { kind: extras.replyGoalKind };
        }

        console.log('[IROS/SHIFT_DECISION][STAMP_FINAL_SHIFT]', {
          shiftKind,
          shiftHint,
          shiftIntent,
          goalKind: extras?.goalKind ?? null,
          targetKind: extras?.targetKind ?? null,
          laneKey: extras?.laneKey ?? null,
          replyGoalKind: extras?.replyGoalKind ?? null,
        });
      } catch {}

      return shiftKind;
    };

    try {
      console.log('[IROS/SHIFT_DECISION][GOALKIND_FIRST]', {
        goalKind2: goalKind2 || null,
        stampedShiftKind: stampedShiftKind || null,
        isClarifyLike,
        suppressClarifyShift,
        hasConvergeSignal2,
        directAnswerRequested2,
        isReturnFlow,
        emotionalTemperature2: emotionalTemperature2 ?? null,
        replyDecisionMode: String(replyDecisionBase?.replyMode ?? '') || null,
        replyDecisionShift: String(replyDecisionBase?.shiftKind ?? '') || null,
        text: t ?? null,
      });
    } catch {}

    // ② 司令塔 goalKind を最優先
    if (goalKind2 === 'resonate') {
      if (hiddenQuestionLandingNow) {
        return stampShiftMeta('clarify_shift', {
          goalKind: 'uncover' as any,
          targetKind: 'uncover' as any,
          laneKey: null,
          replyGoalKind: 'uncover' as any,
        });
      }
      return stampShiftMeta('narrow_shift', {
        goalKind: 'resonate' as any,
        targetKind: 'resonate' as any,
        laneKey: null,
        replyGoalKind: 'resonate' as any,
      });
    }

    if (goalKind2 === 'uncover') {
      if (hiddenQuestionLandingNow) {
        return stampShiftMeta('clarify_shift', {
          goalKind: 'uncover' as any,
          targetKind: 'uncover' as any,
          laneKey: null,
          replyGoalKind: 'uncover' as any,
        });
      }
      const targetKindNowRaw = String((args as any)?.targetKind ?? '').trim();

      const targetKindNow:
        | 'clarify'
        | 'stabilize'
        | 'decide'
        | 'uncover'
        | 'narrow'
        | 'resonate'
        | null =
        targetKindNowRaw === 'clarify' ||
        targetKindNowRaw === 'stabilize' ||
        targetKindNowRaw === 'decide' ||
        targetKindNowRaw === 'uncover' ||
        targetKindNowRaw === 'narrow' ||
        targetKindNowRaw === 'resonate'
          ? targetKindNowRaw
          : null;

          if (targetKindNow === 'resonate') {
            return stampShiftMeta('narrow_shift', {
              goalKind: 'resonate' as any,
              targetKind: 'resonate' as any,
              laneKey: null,
              replyGoalKind: 'resonate' as any,
            });
          }

      return stampShiftMeta('narrow_shift', {
        goalKind: 'resonate' as any,
        targetKind: 'resonate' as any,
        laneKey: null,
        replyGoalKind: 'resonate' as any,
      });
    }

    if (goalKind2 === 'stabilize') {
      const replyGoalKindNow = String(replyDecisionBase?.goalKind ?? '').trim();
      const targetKindNowRaw = String((args as any)?.targetKind ?? '').trim();

      const targetKindNow:
        | 'clarify'
        | 'stabilize'
        | 'decide'
        | 'uncover'
        | 'narrow'
        | null =
        targetKindNowRaw === 'clarify' ||
        targetKindNowRaw === 'stabilize' ||
        targetKindNowRaw === 'decide' ||
        targetKindNowRaw === 'uncover' ||
        targetKindNowRaw === 'narrow'
          ? targetKindNowRaw
          : null;

      console.log('[IROS][SHIFT_INPUT]', {
        goalKind2,
        replyGoalKindNow,
        targetKindNow: targetKindNowRaw,
      });

      if (
        replyGoalKindNow === 'resonate' ||
        targetKindNowRaw === 'resonate'
      ) {
        return stampShiftMeta('narrow_shift', {
          goalKind: 'uncover' as any,
          targetKind: 'resonate' as any,
          laneKey: null,
          replyGoalKind: 'uncover' as any,
        });
      }

      return stampShiftMeta('stabilize_shift', {
        goalKind: 'stabilize',
        targetKind: targetKindNow ?? 'stabilize',
        laneKey: null,
        replyGoalKind: 'stabilize',
      });
    }

    if (goalKind2 === 'clarify') {
      const replyGoalKindNow = String(replyDecisionBase?.goalKind ?? '').trim();
      const targetKindNow = String((args as any)?.targetKind ?? '').trim();

      if (
        replyGoalKindNow === 'resonate' ||
        targetKindNow === 'resonate'
      ) {
        return stampShiftMeta('narrow_shift', {
          goalKind: 'resonate' as any,
          targetKind: 'resonate' as any,
          laneKey: null,
          replyGoalKind: 'resonate' as any,
        });
      }

      if (!suppressClarifyShift) {
        const targetKindNowRaw = String((args as any)?.targetKind ?? '').trim();

        const targetKindNow:
          | 'clarify'
          | 'stabilize'
          | 'decide'
          | 'uncover'
          | 'narrow'
          | null =
          targetKindNowRaw === 'clarify' ||
          targetKindNowRaw === 'stabilize' ||
          targetKindNowRaw === 'decide' ||
          targetKindNowRaw === 'uncover' ||
          targetKindNowRaw === 'narrow'
            ? targetKindNowRaw
            : null;

        return stampShiftMeta('clarify_shift', {
          goalKind: 'clarify',
          targetKind: targetKindNow ?? 'clarify',
          laneKey: null,
          replyGoalKind: 'clarify',
        });
      }
    }

    // ④ stampedShiftKind は fallback
    if (
      stampedShiftKind === 'clarify_shift' ||
      stampedShiftKind === 'stabilize_shift' ||
      stampedShiftKind === 'distance_shift' ||
      stampedShiftKind === 'repair_shift' ||
      stampedShiftKind === 'decide_shift' ||
      stampedShiftKind === 'narrow_shift'
    ) {
      if (stampedShiftKind === 'clarify_shift' && suppressClarifyShift) {
        try {
          console.log('[IROS/SHIFT_DECISION][SUPPRESS_STAMPED_CLARIFY]', {
            stampedShiftKind,
            text: rawTextNow,
            textLenNow,
            isShortAmbiguousFollowup,
            hasConcreteContinuationSignal,
          });
        } catch {}
      } else if (stampedShiftKind === 'decide_shift') {
        return stampShiftMeta('decide_shift', {
          goalKind: 'decide',
          targetKind: 'decide',
          laneKey: 'T_CONCRETIZE',
          replyGoalKind: 'decide',
        });
      } else if (stampedShiftKind === 'stabilize_shift') {
        return stampShiftMeta('stabilize_shift', {
          goalKind: 'stabilize',
          targetKind: 'stabilize',
          laneKey: null,
          replyGoalKind: 'stabilize',
        });
      } else if (stampedShiftKind === 'clarify_shift') {
        return stampShiftMeta('clarify_shift', {
          goalKind: 'clarify',
          targetKind: 'clarify',
          laneKey: null,
          replyGoalKind: 'clarify',
        });
      } else {
        return stampShiftMeta(
          stampedShiftKind as
            | 'distance_shift'
            | 'repair_shift'
            | 'narrow_shift'
        );
      }
    }

    // ⑤ 明示的な意味/定義/真意/ツッコミ系
    if (isClarifyLike && !suppressClarifyShift) {
      const replyGoalKindNow = String(replyDecisionBase?.goalKind ?? '').trim();
      const targetKindNow = String((args as any)?.targetKind ?? '').trim();

      if (replyGoalKindNow === 'resonate' || targetKindNow === 'resonate') {
        return stampShiftMeta('narrow_shift', {
          goalKind: 'resonate' as any,
          targetKind: 'resonate' as any,
          laneKey: null,
          replyGoalKind: 'resonate' as any,
        });
      }

      return stampShiftMeta('clarify_shift', {
        goalKind: 'clarify',
        targetKind: 'clarify',
        laneKey: null,
        replyGoalKind: 'clarify',
      });
    }

    // ⑥ 関係距離・修復・決定の明示語
    if (hasAny('距離', '近すぎる', '離れたい', '遠い', '重い')) {
      return stampShiftMeta('distance_shift');
    }

    if (hasAny('仲直り', '修復', 'やり直したい', '戻りたい')) {
      return stampShiftMeta('repair_shift');
    }

    if (hasAny('決められない', '迷ってる', '選べない', 'やめるべきか', '行くべきか')) {
      return stampShiftMeta('decide_shift', {
        goalKind: 'decide',
        targetKind: 'decide',
        laneKey: 'T_CONCRETIZE',
        replyGoalKind: 'decide',
      });
    }

    // ⑦ RETURN の停滞語だけ stabilize
    const shouldStabilize =
      hasAny('また同じところ', '戻ってきた', '動けない', '止まる', 'しんどい') ||
      (isReturnFlow && emotionalTemperature2 === 'high');

    try {
      console.log('[IROS/SHIFT_DECISION][STABILIZE_CHECK_REAL]', {
        goalKind2: goalKind2 || null,
        shouldStabilize,
        isReturnFlow,
        emotionalTemperature2: emotionalTemperature2 ?? null,
        text: t ?? null,
        hasAnyResult: hasAny(
          'また同じところ',
          '戻ってきた',
          '動けない',
          '止まる',
          'しんどい'
        ),
      });
    } catch {}

    if (shouldStabilize) {
      return stampShiftMeta('stabilize_shift', {
        goalKind: 'stabilize',
        targetKind: 'stabilize',
        laneKey: null,
        replyGoalKind: 'stabilize',
      });
    }

    // ⑧ あいさつは stabilize
    if (
      /^(?:こんにちは|こんちわ|こんばんは|おはよう|やあ|どうも|もしもし|おつかれ|おつかれさま|ただいま)$/u.test(
        String(t ?? '').trim(),
      )
    ) {
      return stampShiftMeta('stabilize_shift', {
        goalKind: 'stabilize',
        targetKind: 'stabilize',
        laneKey: null,
        replyGoalKind: 'stabilize',
      });
    }

    // ⑨ デフォルト narrow
    return stampShiftMeta('narrow_shift');
  })();
  const resolvedAskType2 =
    String((args as any)?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    String((args as any)?.meta?.extra?.ctxPack?.resolvedAsk?.askType ?? '').trim() ||
    '';

  const goalKindForShiftMeta2 =
    String((args as any)?.meta?.extra?.goalKind ?? '').trim() ||
    String((args as any)?.ctxPack?.goalKind ?? '').trim() ||
    String((args as any)?.targetKind ?? '').trim() ||
    '';

  const shiftHint2 = (() => {
    if (goalKindForShiftMeta2 === 'clarify') {
      if (resolvedAskType2 === 'truth_structure') return 'clarify_truth_structure_v1';
      return 'clarify_meaning_v2';
    }

    if (goalKindForShiftMeta2 === 'stabilize') return 'stabilize_shift_v1';
    if (goalKindForShiftMeta2 === 'decide') return 'decide_shift_v1';
    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_shift_v1';

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
    if (goalKindForShiftMeta2 === 'clarify') {
      if (resolvedAskType2 === 'truth_structure') return 'answer_truth_structure';
      return 'meaning_reframe';
    }

    if (goalKindForShiftMeta2 === 'stabilize') return 'stabilize_direction';
    if (goalKindForShiftMeta2 === 'decide') return 'answer_in_one_shot';
    if (goalKindForShiftMeta2 === 'uncover') return 'narrow_focus';

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
          return '答えの中心と、その理由を混ぜずに整理します';
        }

        if (isTopicCorrection) {
          return '直した話の範囲を広げず、その話の中で整理します';
        }

        if (observedStage2.startsWith('I') && primaryStage2.startsWith('R')) {
          return '同じ関係の繰り返しと、どう受け取っているかを分けて見ます';
        }

        if (observedStage2.startsWith('I')) {
          return '出来事そのものより、この流れをどう受け取っているかを見て整理します';
        }

        if (observedStage2.startsWith('R') && secondaryStage2.startsWith('I')) {
          return '同じ関係の繰り返しと、その後ろでつけている意味を分けて見ます';
        }

        if (isDefinitionQuestion2) {
          return shiftMeaning.line;
        }

        return '質問を広げすぎず、この話でいちばん大事なところを見るようにします';
      }

      if (shiftKind2 === 'stabilize_shift') {
        if (hasAny('また同じところ', '戻ってきた')) {
          return 'また同じところに戻っている点を見て整理します';
        }
        return 'いま揺れている見方を、そのまま見直すように整理します';
      }

      if (shiftKind2 === 'distance_shift') {
        return '苦しさが強くなる相手との離れ方を見て整理します';
      }

      if (shiftKind2 === 'repair_shift') {
        return 'すぐ解決しようとせず、関係がどうほどけるかを見る方向で返します';
      }

      if (shiftKind2 === 'decide_shift') {
        return '結論を急ぎすぎず、まず一つだけ決めたいことを見るようにします';
      }

      return '話が広がっているので、いまは見るところを一つにします';
  })();

  const questionForFlow =
    (args.meta as any)?.extra?.question ??
    (args.ctxPack as any)?.question ??
    null;

  const outputPolicyForFlow = questionForFlow?.outputPolicy ?? null;

  const goalKindForShift = (() => {
    const metaGoalKind =
      String((args as any)?.meta?.extra?.goalKind ?? '').trim() ||
      String((args as any)?.ctxPack?.goalKind ?? '').trim() ||
      String((args as any)?.targetKind ?? '').trim() ||
      '';

    if (metaGoalKind) return metaGoalKind;

    const hasLimitCue = hasAny(
      'もう耐えられない',
      '耐えられない',
      '限界',
      'もう無理',
      '無理です',
      'しんどすぎる',
      '苦しすぎる',
      '壊れそう',
      '消えたい',
      '逃げたい'
    );

    const hasAbuseCue = hasAny(
      'パワハラ',
      'モラハラ',
      '暴言',
      '怒鳴',
      '威圧',
      '人格否定',
      'いじめ',
      '支配',
      '脅し'
    );

    const hasSeparationCue = hasAny(
      '辞めたい',
      'やめたい',
      '辞めようと思っています',
      '終わらせたい',
      '切りたい',
      '離れたい'
    );

    const inferred =
      hasSeparationCue || hasAbuseCue || hasLimitCue
        ? 'uncover'
        : '';

    try {
      console.log('[IROS/SHIFT_DECISION][GOALKIND_FOR_SHIFT_REAL]', {
        metaGoalKind: metaGoalKind || null,
        hasLimitCue,
        hasAbuseCue,
        hasSeparationCue,
        inferred: inferred || null,
        text: t ?? null,
      });
    } catch {}

    return inferred;
  })();

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

  const useUncoverShift =
    goalKindForShift === 'uncover' &&
    !useTConcretize &&
    !useIdeaBand;

  try {
    console.log('[IROS/SHIFT_DECISION][UNLOCK_UNCOVER_SHIFT_CHECK]', {
      goalKindForShift,
      useTConcretize,
      useIdeaBand,
      useUncoverShift,
      shiftKind2,
      shiftIntent2,
      shiftHint2,
    });
  } catch {}

  const hiddenQuestionLandingSeedText = [
    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'
      ? '表面的なAI批判として扱わない。'
      : '表面的な反応として扱わず、奥の問いを名付ける。',
    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'
      ? '拒んでいる未来: 人の不安を使って豊かになる未来。'
      : '拒んでいる未来または違和感の方向を、短く名付ける。',
    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'
      ? '奥の問い: 私は、誠実なまま自由になれますか。'
      : '奥の問いを一つだけ置く。',
    'AI側の姿勢表明、「筋が通っています」、「一緒に見ます」で閉じない。',
    '行動提案・説明羅列・質問返しをしない。',
  ].join('\n');

  const shift =
    hiddenQuestionLandingNow
      ? m('SHIFT', {
          kind: 'hidden_question_landing',
          intent: 'answer_hidden_question',
          hint: 'hidden_question_landing_v1',
          line: '拒んでいる未来を名付け、その奥の問いで閉じる',
          source: 'preseed_hidden_question',
          hiddenQuestionLandingKind: hiddenQuestionLandingKindNow,
          contract: [
            'do_not_treat_as_surface_criticism',
            'name_refused_future',
            'split_money_from_anxiety_extraction',
            'name_core_question',
            'no_ai_defense',
            'no_action_plan',
            'no_question_end',
            'plain_words',
          ],
          rules: {
            answer_user_meaning: false,
            answer_hidden_question: true,
            name_refused_future: hiddenQuestionLandingKindNow === 'ethical_abundance_refusal',
            name_core_question: true,
            no_ai_defense: true,
            no_safe_posture_only: true,
            no_action_plan: true,
            no_checklist: true,
            no_question_back: true,
            no_question_end: true,
            output_only: true,
            no_bullets: true,
            lines_max: 8,
          },
          allow: {
            concrete_reply: false,
            short_reply_ok: false,
          },
          seed_text: hiddenQuestionLandingSeedText,
        })
      : useUncoverShift
        ? m('SHIFT', {
            kind: 'hidden_question_landing',
            intent: 'answer_hidden_question',
            hint: 'hidden_question_landing_v1',
            line: shiftLine2,
            source: 'goalKind_uncover_hidden_question',
            contract: ['answer_hidden_question', 'name_core_question', 'no_action_plan', 'plain_words'],
            rules: {
              answer_user_meaning: false,
              answer_hidden_question: true,
              name_core_question: true,
              no_question_back: true,
              no_question_end: true,
              keep_it_simple: true,
              no_flow_lecture: true,
              no_meta_explain: true,
              no_action_plan: true,
              questions_max: 0,
            },
            allow: {
              concrete_reply: false,
              short_reply_ok: true,
            },
            seed_text: seedText,
          })      : useTConcretize
        ? buildShiftTConcretize(seedText, args.focusLabel)
        : useIdeaBand
          ? buildShiftIdeaBand(seedText)
          : m('SHIFT', {
            kind: shiftKind2,
            intent: shiftIntent2,
            decision_target: shiftIntent2,
            hint: shiftHint2,
            line:
              shiftKind2 === 'decide_shift'
                ? '最初の1文で結論を出す / 比較で終わらない / 質問しない / 最後に行動を1つ置く'
                : shiftLine2,
                summary:
                shiftKind2 === 'stabilize_shift'
                  ? 'いまは、何を変えるかより、どこで止まっているかをそのまま見る流れです。'
                  : shiftKind2 === 'decide_shift'
                    ? 'ここでは、論点をひとつに絞って答えを置く流れです。'
                    : shiftKind2 === 'narrow_shift'
                      ? 'ここでは、話を広げすぎず一点に絞って見ます。'
                      : shiftKind2 === 'clarify_shift'
                        ? 'ここでは、まず言いたい芯を取り違えないように整えます。'
                        : shiftLine2
                          ? `${String(shiftLine2).replace(/[。]+$/u, '').trim()}。`
                        : null,
            message:
              shiftKind2 === 'stabilize_shift'
                ? '見方が揺れているまま進めず、いったん整え直して受け取るのが合っています。'
                : shiftKind2 === 'decide_shift'
                  ? '比較を広げるより、ここでは答えをひとつに絞って置くのが合っています。'
                  : shiftKind2 === 'narrow_shift'
                    ? '話を広げすぎず、いまの論点を一点で受け取るのが合っています。'
                    : shiftKind2 === 'clarify_shift'
                      ? 'まずは言葉の芯を取り違えないように整えてから受け取るのが合っています。'
                      : null,
            source: 'phase2_shift',
            rules: {
              answer_user_meaning: shiftKind2 !== 'decide_shift' && !hiddenQuestionLandingNow,
              answer_in_one_shot: shiftKind2 === 'decide_shift',
              first_line_is_core_answer: shiftKind2 === 'decide_shift',
              must_start_with_conclusion: shiftKind2 === 'decide_shift',
              force_assertive: shiftKind2 === 'decide_shift',
              no_question_back: shiftKind2 === 'decide_shift',
              no_question_end: shiftKind2 === 'decide_shift',
              no_compare_list: shiftKind2 === 'decide_shift',
              no_option_enumeration: shiftKind2 === 'decide_shift',
              one_conclusion_only: shiftKind2 === 'decide_shift',
              choose_one_direction: shiftKind2 === 'decide_shift',
              end_with_action: shiftKind2 === 'decide_shift',
              keep_it_simple: true,
              no_flow_lecture: true,
              no_meta_explain: true,
              questions_max: questionsMax2,
            },
            allow: {
              concrete_reply: true,
              short_reply_ok: false,
            },
            seed_text: seedText,
          });

          const healthReport =
          (args as any)?.ctxPack?.healthReport === true ||
          (args as any)?.meta?.extra?.healthReport === true ||
          (args as any)?.meta?.extra?.ctxPack?.healthReport === true;

        const healthReportKindRaw =
          String((args as any)?.ctxPack?.healthReportKind ?? '').trim() ||
          String((args as any)?.meta?.extra?.healthReportKind ?? '').trim() ||
          String((args as any)?.meta?.extra?.ctxPack?.healthReportKind ?? '').trim();

        const healthReportKind:
          | 'initial'
          | 'recovery'
          | 'continuing' =
          healthReportKindRaw === 'recovery' ||
          healthReportKindRaw === 'continuing' ||
          healthReportKindRaw === 'initial'
            ? healthReportKindRaw
            : 'initial';

        const healthCasualReportKind =
          healthReportKind === 'recovery'
            ? 'health_recovery'
            : healthReportKind === 'continuing'
              ? 'health_continuing'
              : 'health_initial';

              const healthShiftLine = (() => {
                if (healthReportKind === 'recovery') {
                  return /1日|一日|１日/.test(t)
                    ? '1日で治ったなら、少しほっとするところです。'
                    : '今は問題ないなら、ひとまず落ち着いていてよかったです。';
                }

                if (healthReportKind === 'continuing') {
                  return 'まだ続いているなら、無理しないほうがいいところです。';
                }

                return 'かなりきつかったことが、まず伝わってきます。';
              })();

        const healthConversationHint = healthReport
          ? {
              casualReportKind: healthCasualReportKind,
              healthReportKind,
              conversationEntry: true,
              writerHint:
                healthReportKind === 'recovery'
                  ? '回復報告として普通の会話語で受ける。「話を置いておく」「閉じる」「大丈夫です」で終わらない。よかった、少しほっとした、という受け方にする。'
                  : healthReportKind === 'continuing'
                    ? '体調が続いている報告として普通の会話語で受ける。観測文・構造文にしない。無理しない方向で短く受ける。'
                    : '体調報告として、まず普通の会話で受ける。「その一文そのもの」「そこに留まっています」「前にあるのは」などの観測文にしない。復唱だけで終わらず、「それはきつかったですね」「かなり大変でしたね」のように自然に受ける。構造説明へ飛ばない。',
            }
          : null;

        return [
          {
            key: 'OBS',
            role: 'assistant',
            style: healthReport ? 'friendly' : 'soft',
            content: m('OBS', {
              laneKey: laneKeyForObs,
              flow: conf === undefined ? { delta } : { delta, confidence: conf },
              ...(healthConversationHint ? healthConversationHint : {}),
            }),
          },
          {
            key: 'SHIFT',
            role: 'assistant',
            style: healthReport ? 'friendly' : 'neutral',
            content: healthReport
              ? m('SHIFT', {
                  kind: 'casual_health_report',
                  healthReportKind,
                  casualReportKind: healthCasualReportKind,
                  intent: 'receive_as_conversation',
                  hint:
                    healthReportKind === 'recovery'
                      ? 'health_recovery_conversation_entry_v1'
                      : healthReportKind === 'continuing'
                        ? 'health_continuing_conversation_entry_v1'
                        : 'health_report_conversation_entry_v1',
                  line: healthShiftLine,
                  rules: {
                    no_observation_phrase: true,
                    no_repeat_only: true,
                    no_structure_explain: true,
                    receive_first: true,
                    plain_words: true,
                  },
                })
              : shift,
          },
          {
            key: 'SAFE',
            role: 'assistant',
            style: healthReport ? 'friendly' : 'soft',
            content: m('SAFE', {
              laneKey: laneKeyForObs,
              flow: conf === undefined ? { delta } : { delta, confidence: conf },
              ...(healthConversationHint
                ? {
                    casualReportKind: healthCasualReportKind,
                    healthReportKind,
                    conversationEntry: true,
                    writerHint:
                      healthReportKind === 'recovery'
                        ? '最後も会話として軽く受ける。話を閉じるより、治ってよかったという自然な受け方にする。'
                        : '最後も構造の余韻ではなく、会話として軽く受ける。医療断定や診断はしない。',
                  }
                : {}),
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
  } else if (
    ((isClarify(userText) && /[?？]/.test(userText)) ||
      resolvedAskType === 'capability_reask' ||
      resolvedAskType === 'truth_structure' ||
      String((question as any)?.questionType ?? '').trim() === 'truth' ||
      String((question as any)?.questionType ?? '').trim() === 'structure')
  ) {
    reason = 'clarify';
    usedClarify = true;
    slots = buildClarify(
      userText,
      laneKeyArg,
      flowDelta,
      flow as any,
      resolvedAskType,
      question,
      (args as any)?.ctxPack?.resolvedAsk ??
        (args as any)?.meta?.extra?.ctxPack?.resolvedAsk ??
        null,
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
