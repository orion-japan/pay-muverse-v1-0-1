#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const files = {
  types: 'src/lib/iros/server/preseed/types.ts',
  preseedFlow: 'src/lib/iros/server/preseed/buildPreSeedFlowDirective.ts',
  normalChat: 'src/lib/iros/slotPlans/normalChat.ts',
  resolvePreSeed: 'src/lib/iros/server/preseed/resolvePreSeedDecision.ts',
};

function abs(rel) {
  return path.join(root, rel);
}

function read(rel) {
  return fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
}

function write(rel, text) {
  fs.writeFileSync(abs(rel), text, 'utf8');
  console.log(`[patched] ${rel}`);
}

function replaceOnce(rel, from, to, label) {
  const text = read(rel);
  if (!text.includes(from)) {
    if (text.includes(to)) {
      console.log(`[skip] ${label}`);
      return;
    }
    throw new Error(`Pattern not found: ${label}`);
  }
  write(rel, text.replace(from, to));
}

function insertAfterOnce(rel, needle, insert, label) {
  const text = read(rel);
  if (text.includes(insert.trim())) {
    console.log(`[skip] ${label}`);
    return;
  }
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`Needle not found: ${label}`);
  const at = idx + needle.length;
  write(rel, text.slice(0, at) + insert + text.slice(at));
}

function replaceBetween(rel, startNeedle, endNeedle, replacement, label) {
  const text = read(rel);
  const start = text.indexOf(startNeedle);
  if (start < 0) {
    if (text.includes(replacement.slice(0, 80).trim())) {
      console.log(`[skip] ${label}`);
      return;
    }
    throw new Error(`Start not found: ${label}`);
  }
  const end = text.indexOf(endNeedle, start);
  if (end < 0) throw new Error(`End not found: ${label}`);
  write(rel, text.slice(0, start) + replacement + text.slice(end));
}

function replaceAllLiteral(rel, from, to, label) {
  const text = read(rel);
  if (!text.includes(from)) {
    console.log(`[skip] ${label}`);
    return;
  }
  write(rel, text.split(from).join(to));
}

function replaceRegexOnce(rel, pattern, replacement, label) {
  const text = read(rel);
  const next = text.replace(pattern, replacement);
  if (next === text) {
    throw new Error(`Pattern not found: ${label}`);
  }
  write(rel, next);
  console.log(`[patched] ${rel}`);
}

function patchTypes() {
  replaceOnce(
    files.types,
    `    shouldLetFlowContinue: boolean;\n  };`,
    `    shouldLetFlowContinue: boolean;\n    answerHiddenQuestion?: boolean;\n    shouldLandHiddenQuestion?: boolean;\n    shouldNameRefusedFuture?: boolean;\n  };`,
    'types:intentionConvergence hidden question flags',
  );

  replaceOnce(
    files.types,
    `    shouldAvoidTooManyOptions?: boolean;\n  };`,
    `    shouldAvoidTooManyOptions?: boolean;\n    shouldLandHiddenQuestion?: boolean;\n    shouldNameRefusedFuture?: boolean;\n    hiddenQuestionLandingKind?: 'ethical_abundance_refusal' | 'intention_refusal' | null;\n  };`,
    'types:writerGuidance hidden question flags',
  );
}

function patchResolvePreSeedDecision() {
  const replacement = `  // ETHICAL_ABUNDANCE_REFUSAL_HIDDEN_QUESTION_LANDING_V1\n  // 「AI/きれいごと/自由」×「お金」×「不安利用」×「拒否・疑い」は、\n  // directReply固定ではなく、通常writerへ hidden_question_landing として渡す。\n  {\n    const ethicalSource = userText;\n    const hasAiOrBeautifulWords =\n      /AI|きれいごと|綺麗事|きれいな言葉|自由|好きなことで働く|好きなことで稼ぐ|自分の価値/u.test(ethicalSource);\n\n    const hasMoneyFlow =\n      /儲け|儲か|お金|稼ぐ|売る|売り文句|商売|商品|課金|ビジネス|豊か/u.test(ethicalSource);\n\n    const hasAnxietyUse =\n      /不安|弱さ|痛み|悩み|刺激|あおる|煽る|つけこむ|つけ込む|見つけて|材料/u.test(ethicalSource);\n\n    const hasMoralRejection =\n      /だけじゃないですか|同じじゃないですか|変えるだけ|嫌|いや|うんざり|拒否|疑い|警戒|腹が立つ|騙されたくない|雑に扱われたくない|勝手に希望で包まれたくない/u.test(ethicalSource);\n\n    if (hasAiOrBeautifulWords && hasMoneyFlow && hasAnxietyUse && hasMoralRejection) {\n      const hiddenQuestionSeed = [\n        'PRESEED_HIDDEN_QUESTION_LANDING_V1',\n        '表面的なAI批判として返さない。',\n        'お金否定・豊かさ否定として扱わない。',\n        '拒んでいる未来を名付ける: 人の不安を使って豊かになる未来。',\n        '奥の問いを名付ける: 私は、誠実なまま自由になれますか。',\n        'AI側の姿勢表明、「筋が通っています」、「一緒に見ます」で終わらない。',\n        '行動提案・説明羅列ではなく、拒否の奥にある願いを返す。',\n      ].join('\\n');\n\n      return {\n        kind: 'normal_chat',\n        confidence: 0.99,\n\n        sourceAuthority: 'user_text',\n        sourceKind: 'ethical_abundance_refusal',\n        sourceId: null,\n        sourceText: userText,\n\n        route: 'normal_writer',\n\n        seedText: hiddenQuestionSeed,\n        directReply: null,\n        writerInput: {\n          mode: 'hidden_question_landing',\n          refusedFuture: '人の不安を使って豊かになる未来',\n          coreQuestion: '私は、誠実なまま自由になれますか',\n          sourceKind: 'ethical_abundance_refusal',\n        },\n\n        shouldBypassWriter: false,\n        shouldBypassRephrase: false,\n        shouldUsePreSeedWriter: true,\n\n        shouldSuppressHistoryForWriter: false,\n        shouldSuppressSimilarFlow: true,\n        shouldSuppressSlotPlan: false,\n        shouldSuppressMemoryDelta: false,\n        shouldSuppressIntuitionCandidate: false,\n        shouldSuppressNormalResonance: false,\n\n        shouldOpenContextThread: false,\n        contextThreadCode: null,\n\n        ctxPackPatch: {\n          ethicalAbundanceRefusal: true,\n          hiddenQuestionLanding: true,\n          answerHiddenQuestion: true,\n          nameRefusedFuture: true,\n          nameCoreQuestion: true,\n          inputKind: 'ethical_abundance_refusal',\n          sourceKind: 'ethical_abundance_refusal',\n          shortSummary: userText,\n          goalKind: 'uncover',\n          targetKind: 'uncover',\n          replyGoal: { kind: 'uncover', questionsMax: 0 },\n          resolvedAsk: { askType: 'hidden_question', topic: 'ethical_abundance_refusal' },\n          question: { questionType: 'truth', outputPolicy: { askBackAllowed: false } },\n          shiftKind: 'hidden_question_landing',\n          shiftIntent: 'answer_hidden_question',\n          shiftHint: 'hidden_question_landing_v1',\n          qCode: 'Q3',\n          depthStage: 'I1',\n          presentationKind: 'ethical_abundance_refusal_hidden_question',\n        },\n\n        metaPatch: {\n          ethicalAbundanceRefusal: true,\n          hiddenQuestionLanding: true,\n          answerHiddenQuestion: true,\n          nameRefusedFuture: true,\n          nameCoreQuestion: true,\n          inputKind: 'ethical_abundance_refusal',\n          sourceKind: 'ethical_abundance_refusal',\n          goalKind: 'uncover',\n          targetKind: 'uncover',\n          replyGoal: { kind: 'uncover', questionsMax: 0 },\n          resolvedAsk: { askType: 'hidden_question', topic: 'ethical_abundance_refusal' },\n          question: { questionType: 'truth', outputPolicy: { askBackAllowed: false } },\n          shiftKind: 'hidden_question_landing',\n          shiftIntent: 'answer_hidden_question',\n          shiftHint: 'hidden_question_landing_v1',\n          q_code: 'Q3',\n          depth_stage: 'I1',\n          presentationKind: 'ethical_abundance_refusal_hidden_question',\n        },\n\n        debug: {\n          reason: 'ethical_abundance_refusal_hidden_question',\n          matchedPattern: 'ethical_abundance_refusal_hidden_question_landing',\n          seedHead: hiddenQuestionSeed.slice(0, 120),\n          sourceTextHead: userText.slice(0, 120),\n        },\n      } as any;\n    }\n  }`;

  replaceBetween(
    files.resolvePreSeed,
    '  // ETHICAL_ABUNDANCE_REFUSAL_FAST_PATH',
    `\n\n  if (/^(おはよう|おはようございます)$/u.test(compact))`,
    replacement,
    'resolvePreSeedDecision: ethical refusal normal_writer route',
  );
}

function patchPreSeedFlowDirective() {
  insertAfterOnce(
    files.preseedFlow,
    `function includesAny(text: string, words: string[]): boolean {\n  return words.some((word) => text.includes(word));\n}\n`,
    `\nfunction isHiddenQuestionLandingInput(value: unknown): boolean {\n  const t = compactText(value);\n  const hasAiOrBeautifulWords = /ai|きれいごと|綺麗事|きれいな言葉|自由|好きなことで働く|好きなことで稼ぐ|自分の価値/u.test(t);\n  const hasMoneyFlow = /儲け|儲か|お金|稼ぐ|売る|売り文句|商売|商品|課金|ビジネス|豊か/u.test(t);\n  const hasAnxietyUse = /不安|弱さ|痛み|悩み|刺激|あおる|煽る|つけこむ|つけ込む|見つけて|材料/u.test(t);\n  const hasMoralRejection = /だけじゃないですか|同じじゃないですか|変えるだけ|嫌|いや|うんざり|拒否|疑い|警戒|腹が立つ|騙されたくない|雑に扱われたくない|勝手に希望で包まれたくない/u.test(t);\n  return hasAiOrBeautifulWords && hasMoneyFlow && hasAnxietyUse && hasMoralRejection;\n}\n`,
    'preseedFlow:hiddenQuestion detector',
  );

  replaceOnce(
    files.preseedFlow,
    `  flowAcceptance: boolean;\n}): string | null {`,
    `  flowAcceptance: boolean;\n  hiddenQuestionLanding: boolean;\n}): string | null {`,
    'preseedFlow:writerSeed arg type hiddenQuestionLanding',
  );

  insertAfterOnce(
    files.preseedFlow,
    `  if (args.shouldHoldAction) {\n    return 'このターンでは行動提案を急がず、関係圧や不安反応から出たCreateを小さくし、自分の方向を失っていないかを先に整える。';\n  }\n`,
    `\n  if (args.hiddenQuestionLanding) {\n    return 'PRESEED_HIDDEN_QUESTION_LANDING: 表面的な批判・怒りとして受け止めて終わらせない。拒んでいる未来を名付け、お金否定・豊かさ否定ではないことを分け、その奥の問いを一つ置く。AI側の姿勢表明や安全な受け止めで閉じない。';\n  }\n`,
    'preseedFlow:writerSeed hiddenQuestionLanding branch',
  );

  replaceOnce(
    files.preseedFlow,
    `    const fallbackText = normalizeText(userText);\n`,
    `    const fallbackText = normalizeText(userText);\n    const fallbackHiddenQuestionLanding = isHiddenQuestionLandingInput(fallbackText);\n`,
    'preseedFlow:fallback hiddenQuestion flag',
  );

  replaceOnce(
    files.preseedFlow,
    `    const fallbackShouldLimitDeepening =\n      fallbackIntentionReached || fallbackCreateReady;`,
    `    const fallbackShouldLimitDeepening =\n      fallbackCreateReady;`,
    'preseedFlow:fallback intention no longer limits deepening',
  );

  replaceRegexOnce(
    files.preseedFlow,
    /: fallbackShouldUseSmallAction\s*\?\s*'ユーザーは言葉や行動の形を求めているため、大きな結論にせず、先に形象を置き、そこから小さく実行できる一歩へ収束させる。'\s*: fallbackIntentionReached\s*\?\s*'ユーザー入力だけでも意図の輪郭が出ているため、これ以上の相手分析・原因分析を増やさず、核心を短く言葉にして収束させる。'/,
    `: fallbackShouldUseSmallAction
               ? 'ユーザーは言葉や行動の形を求めているため、大きな結論にせず、先に形象を置き、そこから小さく実行できる一歩へ収束させる。'
               : fallbackHiddenQuestionLanding
                 ? 'PRESEED_HIDDEN_QUESTION_LANDING: 表面的な批判として扱わず、拒んでいる未来と奥の問いを名付ける。AI側の姿勢表明や安全な受け止めで閉じない。'
               : fallbackIntentionReached
                 ? 'ユーザー入力だけでも意図の輪郭が出ている。深掘りを止めるのではなく、奥の問いを一つ名付け、扱える言葉として置く。'`,
    'preseedFlow:fallback writerSeed hidden question',
  );

  replaceOnce(files.preseedFlow, `        shouldStopAnalysis: fallbackIntentionReached,`, `        shouldStopAnalysis: fallbackShouldLimitDeepening,`, 'preseedFlow:fallback shouldStopAnalysis');
  replaceOnce(files.preseedFlow, `        shouldNameCore: fallbackIntentionReached,`, `        shouldNameCore: fallbackIntentionReached || fallbackHiddenQuestionLanding,\n        answerHiddenQuestion: fallbackHiddenQuestionLanding || fallbackIntentionReached,\n        shouldLandHiddenQuestion: fallbackHiddenQuestionLanding,\n        shouldNameRefusedFuture: fallbackHiddenQuestionLanding,`, 'preseedFlow:fallback hidden question convergence');
  replaceOnce(files.preseedFlow, `        shouldShiftFromAnalysisToPlacement: fallbackIntentionReached || fallbackShouldUseCreate,`, `        shouldShiftFromAnalysisToPlacement: fallbackIntentionReached || fallbackShouldUseCreate || fallbackHiddenQuestionLanding,`, 'preseedFlow:fallback shift placement');
  replaceOnce(files.preseedFlow, `        shouldAvoidTooManyOptions: true,\n      },`, `        shouldAvoidTooManyOptions: true,\n        shouldLandHiddenQuestion: fallbackHiddenQuestionLanding,\n        shouldNameRefusedFuture: fallbackHiddenQuestionLanding,\n        hiddenQuestionLandingKind: fallbackHiddenQuestionLanding ? 'ethical_abundance_refusal' : null,\n      },`, 'preseedFlow:fallback writerGuidance hidden flags');

  replaceOnce(
    files.preseedFlow,
    `  const tInsightReady =\n    intentionFormed &&`,
    `  const hiddenQuestionLanding = isHiddenQuestionLandingInput(userText);\n\n  const tInsightReady =\n    intentionFormed &&`,
    'preseedFlow:normal hiddenQuestion flag',
  );

  replaceOnce(
    files.preseedFlow,
    `  const shouldLimitDeepening =\n    intentionFormed ||\n    sameTargetStreak >= 3 ||`,
    `  const shouldLimitDeepening =\n    sameTargetStreak >= 3 ||`,
    'preseedFlow:normal intention no longer limits deepening',
  );

  replaceOnce(
    files.preseedFlow,
    `  const shouldDeepen =\n    !shouldLimitDeepening &&\n    (inputIntent === 'deepen' ||`,
    `  const shouldDeepen =\n    !shouldLimitDeepening &&\n    !hiddenQuestionLanding &&\n    (inputIntent === 'deepen' ||`,
    'preseedFlow:normal hidden question does not expand analysis',
  );

  replaceOnce(files.preseedFlow, `  const intentionReached = intentionFormed && shouldLimitDeepening;`, `  const intentionReached = (intentionFormed || hiddenQuestionLanding) && !createReady;`, 'preseedFlow:intention reached means landing point');
  replaceOnce(files.preseedFlow, `    flowAcceptance,\n  });`, `    flowAcceptance,\n    hiddenQuestionLanding,\n  });`, 'preseedFlow:writerSeed call hidden flag');
  replaceOnce(files.preseedFlow, `  if (shouldLimitDeepening) avoidSeed.push('相手分析・原因分析を増やしすぎない');`, `  if (shouldLimitDeepening) avoidSeed.push('相手分析・原因分析を増やしすぎない');\n  if (hiddenQuestionLanding) avoidSeed.push('AI側の姿勢表明や安全な受け止めだけで閉じない');`, 'preseedFlow:avoid seed hidden');
  replaceOnce(files.preseedFlow, `      shouldStopAnalysis: intentionReached || shouldLimitDeepening,`, `      shouldStopAnalysis: shouldLimitDeepening,`, 'preseedFlow:normal shouldStopAnalysis');
  replaceOnce(files.preseedFlow, `      shouldNameCore: intentionReached || flowDirection === 'name_intention',`, `      shouldNameCore: intentionReached || flowDirection === 'name_intention' || hiddenQuestionLanding,\n      answerHiddenQuestion: hiddenQuestionLanding || (intentionFormed && !createReady && !flowAcceptance),\n      shouldLandHiddenQuestion: hiddenQuestionLanding || (intentionFormed && !createReady && !flowAcceptance),\n      shouldNameRefusedFuture: hiddenQuestionLanding,`, 'preseedFlow:normal hidden question convergence');
  replaceOnce(files.preseedFlow, `      shouldShiftFromAnalysisToPlacement: shouldLimitDeepening || shouldUseCreate,`, `      shouldShiftFromAnalysisToPlacement: shouldLimitDeepening || shouldUseCreate || hiddenQuestionLanding,`, 'preseedFlow:normal shift placement');
  replaceOnce(files.preseedFlow, `      shouldAvoidTooManyOptions: true,\n    },`, `      shouldAvoidTooManyOptions: true,\n      shouldLandHiddenQuestion: hiddenQuestionLanding || (intentionFormed && !createReady && !flowAcceptance),\n      shouldNameRefusedFuture: hiddenQuestionLanding,\n      hiddenQuestionLandingKind: hiddenQuestionLanding ? 'ethical_abundance_refusal' : (intentionFormed && !createReady && !flowAcceptance ? 'intention_refusal' : null),\n    },`, 'preseedFlow:normal writerGuidance hidden flags');
}

function patchNormalChat() {
  insertAfterOnce(
    files.normalChat,
    `function normalizeLaneKeyOrNull(v: unknown): LaneKey | null {\n  return v === 'IDEA_BAND' || v === 'T_CONCRETIZE' ? v : null;\n}\n`,
    `\nfunction isEthicalAbundanceRefusalInput(value: unknown): boolean {\n  const t = String(value ?? '').replace(/[ \\t\\r\\n　]/g, '').toLowerCase();\n  const hasAiOrBeautifulWords = /ai|きれいごと|綺麗事|きれいな言葉|自由|好きなことで働く|好きなことで稼ぐ|自分の価値/u.test(t);\n  const hasMoneyFlow = /儲け|儲か|お金|稼ぐ|売る|売り文句|商売|商品|課金|ビジネス|豊か/u.test(t);\n  const hasAnxietyUse = /不安|弱さ|痛み|悩み|刺激|あおる|煽る|つけこむ|つけ込む|見つけて|材料/u.test(t);\n  const hasMoralRejection = /だけじゃないですか|同じじゃないですか|変えるだけ|嫌|いや|うんざり|拒否|疑い|警戒|腹が立つ|騙されたくない|雑に扱われたくない|勝手に希望で包まれたくない/u.test(t);\n  return hasAiOrBeautifulWords && hasMoneyFlow && hasAnxietyUse && hasMoralRejection;\n}\n`,
    'normalChat:ethical detector',
  );

  replaceAllLiteral(files.normalChat, `'tc_create_hint'`, `'imaginal_create_hint'`, 'normalChat:imaginal create next hint mode');

  const ideaReplacement = `function buildShiftIdeaBand(seedText: string) {\n  /**\n   * ==================================================\n   * IDEA_BAND（一点照射 / spotlight）\n   *\n   * - 添え候補 2本\n   * - 推し 1本\n   * - 合計3行\n   * - 説明しない / 理由を書かない / 質問しない\n   * ==================================================\n   */\n  const lineCount = 3;\n\n  return m('SHIFT', {\n    kind: 'idea_band',\n    intent: 'spotlight_one',\n    hint: 'idea_band_spotlight_v1',\n    rules: {\n      ...SHIFT_PRESET_C_SENSE_HINT.rules,\n      candidates_min: lineCount,\n      candidates_max: lineCount,\n      lines_max: lineCount,\n      support_candidates: 2,\n      spotlight_candidates: 1,\n      questions_max: 0,\n      no_question_back: true,\n      no_question_end: true,\n      no_decision: false,\n      no_action_commit: true,\n      no_lecture: true,\n      no_future_instruction: true,\n      no_checklist: true,\n      no_explanation: true,\n      no_reason: true,\n      mode: 'spotlight',\n      spotlight_last_line: true,\n      spotlight_label: '🌀 推し',\n      spotlight_style: 'confident_hypothesis',\n    },\n    tone: SHIFT_PRESET_C_SENSE_HINT.tone ?? undefined,\n    allow: { ...(SHIFT_PRESET_C_SENSE_HINT.allow ?? {}), short_reply_ok: false },\n    format: {\n      lines: lineCount,\n      schema: ['support_candidate_line', 'support_candidate_line', 'spotlight_line_with_label'],\n      line_contract: 'two_support_candidates_then_one_spotlight',\n    },\n    seed_text: clamp(seedText, 240),\n  });\n}\n`;

  replaceBetween(
    files.normalChat,
    'function buildShiftIdeaBand(seedText: string) {',
    `\n\n// --- 置き換え 1) buildShiftTConcretize を関数まるごと置き換え ---`,
    ideaReplacement,
    'normalChat:IDEA_BAND spotlight contract',
  );

  replaceOnce(
    files.normalChat,
    `  const t = norm(args.userText);\n  const createAxisNow =`,
    `  const t = norm(args.userText);\n  const preSeedFlowDirectiveNow =\n    (args as any)?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.extra?.ctxPack?.preSeedFlowDirective ??\n    (args as any)?.meta?.preSeedFlowDirective ??\n    null;\n  const hiddenQuestionLandingNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    (args as any)?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.ctxPack?.hiddenQuestionLanding === true ||\n    (args as any)?.meta?.extra?.hiddenQuestionLanding === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.answerHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.intentionConvergence?.shouldLandHiddenQuestion === true ||\n    preSeedFlowDirectiveNow?.writerGuidance?.shouldLandHiddenQuestion === true;\n  const hiddenQuestionLandingKindNow =\n    isEthicalAbundanceRefusalInput(args.userText) ||\n    (args as any)?.ctxPack?.ethicalAbundanceRefusal === true ||\n    (args as any)?.meta?.extra?.ctxPack?.ethicalAbundanceRefusal === true\n      ? 'ethical_abundance_refusal'\n      : 'intention_refusal';\n  const createAxisNow =`,
    'normalChat:flow hidden question flags',
  );

  replaceOnce(
    files.normalChat,
    `    if (goalKind2 === 'resonate') {\n      return stampShiftMeta('narrow_shift', {`,
    `    if (goalKind2 === 'resonate') {\n      if (hiddenQuestionLandingNow) {\n        return stampShiftMeta('clarify_shift', {\n          goalKind: 'uncover' as any,\n          targetKind: 'uncover' as any,\n          laneKey: null,\n          replyGoalKind: 'uncover' as any,\n        });\n      }\n      return stampShiftMeta('narrow_shift', {`,
    'normalChat:resonate hidden question escape',
  );

  replaceOnce(
    files.normalChat,
    `    if (goalKind2 === 'uncover') {\n      const targetKindNowRaw = String((args as any)?.targetKind ?? '').trim();`,
    `    if (goalKind2 === 'uncover') {\n      if (hiddenQuestionLandingNow) {\n        return stampShiftMeta('clarify_shift', {\n          goalKind: 'uncover' as any,\n          targetKind: 'uncover' as any,\n          laneKey: null,\n          replyGoalKind: 'uncover' as any,\n        });\n      }\n      const targetKindNowRaw = String((args as any)?.targetKind ?? '').trim();`,
    'normalChat:uncover hidden question escape',
  );

  const hiddenShiftReplacement = `  const hiddenQuestionLandingSeedText = [\n    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'\n      ? '表面的なAI批判として扱わない。'\n      : '表面的な反応として扱わず、奥の問いを名付ける。',\n    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'\n      ? '拒んでいる未来: 人の不安を使って豊かになる未来。'\n      : '拒んでいる未来または違和感の方向を、短く名付ける。',\n    hiddenQuestionLandingKindNow === 'ethical_abundance_refusal'\n      ? '奥の問い: 私は、誠実なまま自由になれますか。'\n      : '奥の問いを一つだけ置く。',\n    'AI側の姿勢表明、「筋が通っています」、「一緒に見ます」で閉じない。',\n    '行動提案・説明羅列・質問返しをしない。',\n  ].join('\\n');\n\n  const shift =\n    hiddenQuestionLandingNow\n      ? m('SHIFT', {\n          kind: 'hidden_question_landing',\n          intent: 'answer_hidden_question',\n          hint: 'hidden_question_landing_v1',\n          line: '拒んでいる未来を名付け、その奥の問いで閉じる',\n          source: 'preseed_hidden_question',\n          hiddenQuestionLandingKind: hiddenQuestionLandingKindNow,\n          contract: [\n            'do_not_treat_as_surface_criticism',\n            'name_refused_future',\n            'split_money_from_anxiety_extraction',\n            'name_core_question',\n            'no_ai_defense',\n            'no_action_plan',\n            'no_question_end',\n            'plain_words',\n          ],\n          rules: {\n            answer_user_meaning: false,\n            answer_hidden_question: true,\n            name_refused_future: hiddenQuestionLandingKindNow === 'ethical_abundance_refusal',\n            name_core_question: true,\n            no_ai_defense: true,\n            no_safe_posture_only: true,\n            no_action_plan: true,\n            no_checklist: true,\n            no_question_back: true,\n            no_question_end: true,\n            output_only: true,\n            no_bullets: true,\n            lines_max: 8,\n          },\n          allow: {\n            concrete_reply: false,\n            short_reply_ok: false,\n          },\n          seed_text: hiddenQuestionLandingSeedText,\n        })\n      : useUncoverShift\n        ? m('SHIFT', {\n            kind: 'hidden_question_landing',\n            intent: 'answer_hidden_question',\n            hint: 'hidden_question_landing_v1',\n            line: shiftLine2,\n            source: 'goalKind_uncover_hidden_question',\n            contract: ['answer_hidden_question', 'name_core_question', 'no_action_plan', 'plain_words'],\n            rules: {\n              answer_user_meaning: false,\n              answer_hidden_question: true,\n              name_core_question: true,\n              no_question_back: true,\n              no_question_end: true,\n              keep_it_simple: true,\n              no_flow_lecture: true,\n              no_meta_explain: true,\n              no_action_plan: true,\n              questions_max: 0,\n            },\n            allow: {\n              concrete_reply: false,\n              short_reply_ok: true,\n            },\n            seed_text: seedText,\n          })`;

  replaceBetween(
    files.normalChat,
    `  const shift =\n    useUncoverShift\n      ? m('SHIFT', {`,
    `      : useTConcretize`,
    hiddenShiftReplacement,
    'normalChat:hidden question shift output',
  );

  replaceOnce(
    files.normalChat,
    `              answer_user_meaning: shiftKind2 !== 'decide_shift',`,
    `              answer_user_meaning: shiftKind2 !== 'decide_shift' && !hiddenQuestionLandingNow,`,
    'normalChat:disable answer_user_meaning for hidden question',
  );
}

function main() {
  patchTypes();
  patchResolvePreSeedDecision();
  patchPreSeedFlowDirective();
  patchNormalChat();
  console.log('\\nDone. Run: npm run typecheck');
}

main();
