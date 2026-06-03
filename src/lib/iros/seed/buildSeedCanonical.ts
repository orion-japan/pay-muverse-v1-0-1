// src/lib/iros/seed/buildSeedCanonical.ts

export type SeedTone = 'soft' | 'normal' | 'assertive';
export type SeedDepth = 'shallow' | 'normal' | 'deep';

export type MeaningSkeletonV2 = {
  transitionMeaning?: string | null;
  structuralMeaning?: string | null;
  focus?: string | null;
  relationContext?: string | null;
  oneLineConstraint?: string | null;
};

export type Flow180Like = {
  primary?: string | null;
  from?: string | null;
  to?: string | null;
  deltaType?: string | null;
  sentence?: string | null;
};

export type WriterDirectivesLike = {
  flowLine?: string | null;
  deltaLine?: string | null;
  flowFrom?: string | null;
  flowTo?: string | null;
  writeConstraints?: string[] | null;
};

export type ConversationAnchor = {
  source?: 'rule' | 'llm' | 'mixed';

  observationTarget?: string | null;
  mainSubject?: string | null;
  meaningCore?: string | null;

  continuityMode?: string | null;

  forbidEscape?: string[] | null;

  llmHint?: {
    enabled?: boolean;
    candidate?: string | null;
  } | null;
};

export type ResolvedReference = {
  type?: 'deictic_reference' | string;
  scope?: 'current_turn' | string;
  sourcePhrase?: string | null;
  referenceTarget?: string | null;
  currentQuestion?: string | null;
  mainSubject?: string | null;
  askType?: 'reference_check' | string;
  askFrame?: string | null;
  expiresAfterTurn?: boolean | null;
};

export type ReferenceCheckRule = {
  firstDecision?: 'required' | string;
  answerMode?: 'yes_no_partial' | string;
  doNotDefaultToAffirmation?: boolean | null;
  separateStructureFromIdentity?: boolean | null;
  doNotAnswerByMood?: boolean | null;
  doNotConvertCheckToEmpathy?: boolean | null;
  ifReferenceContainsReligionOrPracticeOrBody?: 'state_not_identical_first' | string | null;
};


export type SeedCanonicalInput = {
  conversationAnchor?: ConversationAnchor | null;
  resolvedReference?: ResolvedReference | null;
  referenceCheckRule?: ReferenceCheckRule | null;
  meaningSkeleton?: MeaningSkeletonV2 | null;
  flow180?: Flow180Like | null;

  flow?: {
    current?: string | null;
    prev?: string | null;
    delta?: string | null;
    energy?: string | null;
    futureRandom?: string | null;
  } | null;

  /**
   * currentFlow → secondFlow の状態移管SEED。
   * Writerには意味生成させず、ここで圧縮済みの移管情報だけを渡す。
   */
  transferSeedText?: string | null;

  /**
   * TCF Rotation が作る収束・回転SEED。
   * Writerには判定だけを渡し、本文生成はさせない。
   */
  tcfRotationSeedText?: string | null;

  /**
   * HumanContextOrchestrator が作る司令塔SEED。
   * 3軸 / Qコード / questionType / futureRandom の扱いを Writer に渡す。
   */
  humanContextOrchestrationText?: string | null;

  focus?: string | null;
  tone?: string | null;
  pressure?: string | null;
  meaning?: string | null;

  userCore?: string | null;
  historyLine?: string | null;

  writerDirectives?: WriterDirectivesLike | null;

  askBackAllowed?: boolean | null;
  questionsMax?: number | null;

  goalKind?: string | null;
  depthStage?: string | null;
  phase?: string | null;
  qCode?: string | null;
  eTurn?: string | null;

  surfacePlan?: {
    obsCore?: string | null;
    shiftCore?: string | null;
    nextCore?: string | null;
    safeCore?: string | null;

    obsLine?: string | null;
    shiftLine?: string | null;
    nextLine?: string | null;
    safeLine?: string | null;
  } | null;
};

export type SeedCanonical = {
  focus: string;
  tone: SeedTone;
  depth: SeedDepth;
  pressure: string;
  relationContext?: string | null;
  oneLineConstraint: string;

  meaning: string;

  flow: {
    current: string | null;
    prev: string | null;
    delta: string | null;
    energy: string | null;
    futureRandom: string | null;
  };

  transferSeedText: string | null;
  tcfRotationSeedText: string | null;
  humanContextOrchestrationText: string | null;

  state: {
    from: string | null;
    to: string | null;
    flow: string | null;
    deltaType: string | null;
  };

  context: {
    userCore: string | null;
    historyLine: string | null;
  };

  conversationAnchor?: ConversationAnchor | null;
  resolvedReference?: ResolvedReference | null;
  referenceCheckRule?: ReferenceCheckRule | null;

  meta: {
    goalKind: string | null;
    depthStage: string | null;
    phase: string | null;
    qCode: string | null;
    eTurn: string | null;
  };

  surfacePlan: {
    obsCore: string | null;
    shiftCore: string | null;
    nextCore: string | null;
    safeCore: string | null;

    obsLine: string | null;
    shiftLine: string | null;
    nextLine: string | null;
    safeLine: string | null;
  };

  rules: string[];
  text: string;
};

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (s === '(null)' || s === 'null' || s === 'undefined') return null;
  return s;
}

function compactLines(lines: Array<string | null | undefined>): string {
  return lines
    .map((v) => clean(v))
    .filter((v): v is string => Boolean(v))
    .join('\n')
    .trim();
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const s = clean(value);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function mapTone(inputTone: string | null, goalKind: string | null): SeedTone {
  const tone = (clean(inputTone) ?? '').toLowerCase();

  if (tone === 'clear') return 'normal';
  if (tone === 'soft') return 'soft';
  if (tone === 'assertive') return 'assertive';

  if (goalKind === 'stabilize') return 'soft';
  return 'normal';
}

function mapDepth(depthStage: string | null): SeedDepth {
  const ds = clean(depthStage);
  if (!ds) return 'normal';

  if (/^(S1|S2)$/i.test(ds)) return 'shallow';
  if (/^(S3|R1|R2|R3|C1|C2|C3)$/i.test(ds)) return 'normal';
  return 'deep';
}

function buildMeaning(input: SeedCanonicalInput): string {
  const explicitMeaning = clean(input.meaning);
  const fromInputFocus = clean(input.focus);
  const fromUserCore = clean(input.userCore);
  const fromHistoryLine = clean(input.historyLine);

  const structuralMeaning = clean(input.meaningSkeleton?.structuralMeaning);
  const transitionMeaning = clean(input.meaningSkeleton?.transitionMeaning);

  const isCommand = (v: string | null) =>
    v != null &&
    /^(stabilize|forward|backward|return|expand|clarify|observe)$/i.test(v);

  const cleanTransition =
    transitionMeaning && !isCommand(transitionMeaning)
      ? transitionMeaning
      : null;

      const fromFlow180 =
      clean(input.flow180?.primary) && !isCommand(clean(input.flow180?.primary))
        ? clean(input.flow180?.primary)
        : null;

    return (
      explicitMeaning ??
      structuralMeaning ??
      cleanTransition ??
      fromFlow180 ??
      fromInputFocus ??
      fromUserCore ??
      fromHistoryLine ??
      '今回の返答は一点に収束させる'
    );
}

function buildFocus(input: SeedCanonicalInput): string {
  const fromInputFocus = clean(input.focus);
  if (fromInputFocus) return fromInputFocus;

  const fromUserCore = clean(input.userCore);
  if (fromUserCore) return fromUserCore;

  const fromHistoryLine = clean(input.historyLine);
  if (fromHistoryLine) return fromHistoryLine;

  const fromSkeletonFocus = clean(input.meaningSkeleton?.focus);
  if (fromSkeletonFocus) return fromSkeletonFocus;

  return '今回の焦点を一つに絞る';
}

function buildRelationContext(input: SeedCanonicalInput): string | null {
  return clean(input.meaningSkeleton?.relationContext);
}

function buildOneLineConstraint(input: SeedCanonicalInput): string {
  const normalizeConstraint = (value: string | null | undefined): string | null => {
    const normalized = clean(value)
      ?.replace(/説明を増やさない/g, '根拠ある意味展開は許可')
      .replace(/seedにない新しい具体軸を足さない/g, '根拠のない個人背景・過去・原因は足さない')
      .replace(/同じ核を言い換えて深める/g, '同じ問いの中で定義・階層・象徴まで深める')
      .replace(/必要以上に構造化せず/g, '必要に応じて定義・階層化・象徴化してよい')
      .replace(/説明を足さず/g, '根拠ある説明は展開してよい');

    return normalized || null;
  };

  const fromSkeleton = normalizeConstraint(input.meaningSkeleton?.oneLineConstraint);
  if (fromSkeleton) return fromSkeleton;

  const pieces = [
    '1核心',
    '根拠ある意味展開は許可',
    '定義・階層化・象徴化は許可',
    '根拠のない個人背景・過去・原因は足さない',
    '同じ問いの中で定義・階層・象徴まで深める',
  ];

  const askBackAllowed = input.askBackAllowed === true;
  const questionsMax =
    typeof input.questionsMax === 'number' ? input.questionsMax : null;

  if (questionsMax === 0) {
    pieces.push('質問しない');
  } else if (!askBackAllowed) {
    pieces.push('状況に応じて、必要な場合だけ短い確認質問を1つまで許可する');
  }

  return pieces.join(' / ');
}

function buildRules(input: SeedCanonicalInput): string[] {
  const base = uniqueStrings(input.writerDirectives?.writeConstraints ?? []);
  const out = [...base];

  const hasNoQuestion = out.some((v) => /質問しない/.test(v));
  const hasConditionalQuestion = out.some((v) => /状況に応じて、必要な場合だけ短い確認質問を1つまで許可する/.test(v));

  const askBackAllowed = input.askBackAllowed === true;
  const questionsMax =
    typeof input.questionsMax === 'number' ? input.questionsMax : null;

  if (questionsMax === 0 && !hasNoQuestion) {
    out.push('質問しない');
  } else if (!askBackAllowed && !hasNoQuestion && !hasConditionalQuestion) {
    out.push('状況に応じて、必要な場合だけ短い確認質問を1つまで許可する');
  }

  if (clean(input.goalKind) === 'stabilize') {
    if (!out.some((v) => /新しい論点/.test(v))) {
      out.push('新しい論点を増やさない');
    }
  }

  return out;
}

function buildSeedText(seed: Omit<SeedCanonical, 'text'>): string {
  const line = (label: string, value: string | null | undefined): string | null => {
    const s = clean(value);
    if (!s) return null;
    return `${label}:\n${s}`;
  };

  const differenceText = [
    clean(seed.state.flow),
    clean(seed.state.from) && clean(seed.state.to)
      ? `${clean(seed.state.from)} -> ${clean(seed.state.to)}`
      : null,
    clean(seed.flow.delta),
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const conversationAnchorText = [
    clean(seed.conversationAnchor?.observationTarget)
      ? `observationTarget=${clean(seed.conversationAnchor?.observationTarget)}`
      : null,
    clean(seed.conversationAnchor?.mainSubject)
      ? `mainSubject=${clean(seed.conversationAnchor?.mainSubject)}`
      : null,
    clean(seed.conversationAnchor?.meaningCore)
      ? `meaningCore=${clean(seed.conversationAnchor?.meaningCore)}`
      : null,
    clean(seed.conversationAnchor?.continuityMode)
      ? `continuityMode=${clean(seed.conversationAnchor?.continuityMode)}`
      : null,
    Array.isArray(seed.conversationAnchor?.forbidEscape) &&
    seed.conversationAnchor?.forbidEscape?.length
      ? `forbidEscape=${seed.conversationAnchor.forbidEscape
          .map((v) => clean(v))
          .filter((v): v is string => Boolean(v))
          .join(' / ')}`
      : null,
    seed.conversationAnchor?.llmHint?.enabled
      ? `llmHint=${clean(seed.conversationAnchor?.llmHint?.candidate) ?? 'enabled'}`
      : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const resolvedReferenceText = [
    clean(seed.resolvedReference?.type)
      ? `type=${clean(seed.resolvedReference?.type)}`
      : null,
    clean(seed.resolvedReference?.scope)
      ? `scope=${clean(seed.resolvedReference?.scope)}`
      : null,
    clean(seed.resolvedReference?.sourcePhrase)
      ? `sourcePhrase=${clean(seed.resolvedReference?.sourcePhrase)}`
      : null,
    clean(seed.resolvedReference?.referenceTarget)
      ? `referenceTarget=${clean(seed.resolvedReference?.referenceTarget)}`
      : null,
    clean(seed.resolvedReference?.currentQuestion)
      ? `currentQuestion=${clean(seed.resolvedReference?.currentQuestion)}`
      : null,
    clean(seed.resolvedReference?.mainSubject)
      ? `mainSubject=${clean(seed.resolvedReference?.mainSubject)}`
      : null,
    clean(seed.resolvedReference?.askType)
      ? `askType=${clean(seed.resolvedReference?.askType)}`
      : null,
    clean(seed.resolvedReference?.askFrame)
      ? `askFrame=${clean(seed.resolvedReference?.askFrame)}`
      : null,
    seed.resolvedReference?.expiresAfterTurn === true
      ? 'expiresAfterTurn=true'
      : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

    const referenceCheckRuleText = [
    clean(seed.referenceCheckRule?.firstDecision)
      ? `first_decision=${clean(seed.referenceCheckRule?.firstDecision)}`
      : null,
    clean(seed.referenceCheckRule?.answerMode)
      ? `answer_mode=${clean(seed.referenceCheckRule?.answerMode)}`
      : null,
    seed.referenceCheckRule?.doNotDefaultToAffirmation === true
      ? 'do_not_default_to_affirmation=true'
      : null,
    seed.referenceCheckRule?.separateStructureFromIdentity === true
      ? 'separate_structure_from_identity=true'
      : null,
    seed.referenceCheckRule?.doNotAnswerByMood === true
      ? 'do_not_answer_by_mood=true'
      : null,
    seed.referenceCheckRule?.doNotConvertCheckToEmpathy === true
      ? 'do_not_convert_check_to_empathy=true'
      : null,
    clean(seed.referenceCheckRule?.ifReferenceContainsReligionOrPracticeOrBody)
      ? `if_reference_contains_religion_or_practice_or_body=${clean(
          seed.referenceCheckRule?.ifReferenceContainsReligionOrPracticeOrBody,
        )}`
      : null,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const surfacePlanText = [
      clean(seed.surfacePlan.obsCore) ? `OBS=${clean(seed.surfacePlan.obsCore)}` : null,
      clean(seed.surfacePlan.shiftCore) ? `SHIFT=${clean(seed.surfacePlan.shiftCore)}` : null,
      clean(seed.surfacePlan.nextCore) ? `NEXT=${clean(seed.surfacePlan.nextCore)}` : null,
      clean(seed.surfacePlan.safeCore) ? `SAFE=${clean(seed.surfacePlan.safeCore)}` : null,

      clean(seed.surfacePlan.obsLine) ? `OBS_LINE=${clean(seed.surfacePlan.obsLine)}` : null,
      clean(seed.surfacePlan.shiftLine) ? `SHIFT_LINE=${clean(seed.surfacePlan.shiftLine)}` : null,
      clean(seed.surfacePlan.nextLine) ? `NEXT_LINE=${clean(seed.surfacePlan.nextLine)}` : null,
      clean(seed.surfacePlan.safeLine) ? `SAFE_LINE=${clean(seed.surfacePlan.safeLine)}` : null,
    ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

    return compactLines([
      'SEED (DO NOT OUTPUT):',
      '',
      line('FLOW', [
        clean(seed.flow.current) ? `current=${clean(seed.flow.current)}` : null,
        clean(seed.flow.prev) ? `prev=${clean(seed.flow.prev)}` : null,
        clean(seed.flow.delta) ? `delta=${clean(seed.flow.delta)}` : null,
        clean(seed.flow.energy) ? `energy=${clean(seed.flow.energy)}` : null,
        clean(seed.flow.futureRandom) ? `futureRandom=${clean(seed.flow.futureRandom)}` : null,
      ]
        .filter((v): v is string => Boolean(v))
        .join('\n')),
      line('CONTEXT', clean(seed.context.userCore) ?? clean(seed.focus)),
      line('DIFFERENCE', differenceText),
      line('RESOLVED_REFERENCE', resolvedReferenceText),
      line('REFERENCE_CHECK_RULE', referenceCheckRuleText),
      line('ANCHOR', conversationAnchorText),
      line('TRANSFER_SEED', clean(seed.transferSeedText)),
      line('TCF_ROTATION_SEED', clean(seed.tcfRotationSeedText)),
      line('HUMAN_CONTEXT_ORCHESTRATION', clean(seed.humanContextOrchestrationText)),
      line('FOCUS', clean(seed.focus)),
      line('TONE', clean(seed.tone)),
      line('PRESSURE', clean(seed.pressure)),
      line('DEPTH', clean(seed.depth)),
      line('SURFACE_PLAN', surfacePlanText),
      line('ONE_LINE_CONSTRAINT', clean(seed.oneLineConstraint)),
      line('RELATION', clean(seed.relationContext)),
    ]);
}

export function buildSeedCanonical(input: SeedCanonicalInput): SeedCanonical {
  const baseMeaning = buildMeaning(input);
  const focus = buildFocus(input);
  const tone = mapTone(clean(input.tone), clean(input.goalKind));
  const depth = mapDepth(clean(input.depthStage));

  const goalKind = clean(input.goalKind);
  const rawPressure = clean(input.pressure);

  const pressure =
    goalKind === 'decide'
      ? 'concretize'
      : goalKind === 'stabilize' && rawPressure === 'narrow'
        ? 'narrow'
        : rawPressure ?? 'observe';

  const relationContext = buildRelationContext(input);
  const oneLineConstraint = buildOneLineConstraint(input);
  const rules = buildRules(input);

  const structuralMeaning = clean(input.meaningSkeleton?.structuralMeaning);
  const transitionMeaning = clean(input.meaningSkeleton?.transitionMeaning);
  const flowSentence = clean(input.flow180?.sentence);
  const deltaLine = clean(input.writerDirectives?.deltaLine);
  const userCore = clean(input.userCore);
  const historyLine = clean(input.historyLine);

  const joinedSignals = [
    structuralMeaning,
    transitionMeaning,
    userCore,
    historyLine,
    baseMeaning,
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

  const hasContrastStructure =
    /(?:一方|でも|けど|しかし|なのに|反面|一つは|もう一つは|AかB|どちら|比較|揺れ)/.test(
      joinedSignals,
    ) ||
    ((joinedSignals.match(/(?:たい|したい|気になる|惹かれる)/g) ?? []).length >= 1 &&
      (joinedSignals.match(/(?:現実|実際|手が動く|進む|進める|続ける|残す|伸ばす)/g) ?? []).length >= 1);

  const biasToReality =
    /(?:実際|現実|手が動く|進む|進める|続ける|残す|伸ばす|もう分かっている|本当は)/.test(
      joinedSignals,
    );

  const hasImplicitDecision =
    /(?:もう分かっている|本当は|実際は|手が動くのは|進めばいい|向いている)/.test(
      joinedSignals,
    ) || biasToReality;

  const hasDirectionBias = biasToReality;

  const hasDeepCStructure =
    hasContrastStructure && hasImplicitDecision && hasDirectionBias;

    const pickA =
    structuralMeaning ||
    transitionMeaning ||
    userCore ||
    '';

  const pickB =
    userCore && /でも|けど|しかし/.test(userCore)
      ? userCore.split(/でも|けど|しかし/).pop()?.trim() ?? ''
      : '';

      const meaning = hasDeepCStructure
      ? (() => {
          const b =
            pickB ||
            (pickA.match(/現実.*?(?:やる|続ける|伸ばす|進める)/)?.[0] ?? '') ||
            '現実に向くほう';

          return `もう${b}へ気持ちは寄っている。`;
        })()
    : baseMeaning;

    const safeMeaningSource =
    structuralMeaning ??
    transitionMeaning ??
    null;

  const safeGateText = [
    clean(input.userCore),
    clean(input.focus),
    clean(input.meaningSkeleton?.focus),
  ]
    .filter((v): v is string => Boolean(v))
    .join('\n');

    const isAnswerSafeMode =
    safeMeaningSource != null &&
    /どういうこと|なぜ|原因|構造|答えて|教えて/.test(safeGateText);

  const shouldExposeSafeMeaning = isAnswerSafeMode;

  const seedWithoutText: Omit<SeedCanonical, 'text'> = {
    focus,
    tone,
    depth,
    pressure,
    relationContext,
    oneLineConstraint,

    meaning,

    flow: {
      current: clean(input.flow?.current),
      prev: clean(input.flow?.prev),
      delta: clean(input.flow?.delta),
      energy: clean(input.flow?.energy),
      futureRandom: clean(input.flow?.futureRandom),
    },

    transferSeedText: clean(input.transferSeedText),
    tcfRotationSeedText: clean(input.tcfRotationSeedText),
    humanContextOrchestrationText: clean(input.humanContextOrchestrationText),

    state: {
      from: clean(input.flow180?.from) ?? clean(input.writerDirectives?.flowFrom),
      to: clean(input.flow180?.to) ?? clean(input.writerDirectives?.flowTo),
      flow: clean(input.flow180?.primary),
      deltaType: clean(input.flow180?.deltaType),
    },

    context: {
      userCore: clean(input.userCore) ?? clean(input.focus),
      historyLine: clean(input.historyLine),
    },

    conversationAnchor: input.conversationAnchor ?? null,
    resolvedReference: input.resolvedReference ?? null,
    referenceCheckRule: input.referenceCheckRule ?? null,

    meta: {
      goalKind,
      depthStage: clean(input.depthStage),
      phase: clean(input.phase),
      qCode: clean(input.qCode),
      eTurn: clean(input.eTurn),
    },

    surfacePlan: {
      obsCore:
        clean(input.surfacePlan?.obsCore) ??
        clean(input.userCore) ??
        clean(input.focus),

      shiftCore:
        clean(input.surfacePlan?.shiftCore) ??
        clean(input.flow180?.primary) ??
        structuralMeaning ??
        transitionMeaning ??
        null,

      nextCore:
        clean(input.surfacePlan?.nextCore) ??
        clean(input.meaningSkeleton?.focus) ??
        clean(input.focus),

      safeCore:
        clean(input.surfacePlan?.safeCore) ??
        (shouldExposeSafeMeaning ? safeMeaningSource : null),

      obsLine:
        clean(input.surfacePlan?.obsLine) ??
        (() => {
          const v =
            clean(input.surfacePlan?.obsCore) ??
            clean(input.userCore) ??
            clean(input.focus);
          if (!v) return null;
          return /[。！？]$/.test(v) ? v : `${v}。`;
        })(),

      shiftLine:
        clean(input.surfacePlan?.shiftLine) ??
        (() => {
          const v =
            clean(input.surfacePlan?.shiftCore) ??
            clean(input.flow180?.primary) ??
            structuralMeaning ??
            transitionMeaning;
          if (!v) return null;
          return /[。！？]$/.test(v) ? v : `${v}。`;
        })(),

      nextLine:
        clean(input.surfacePlan?.nextLine) ??
        (() => {
          const v =
            clean(input.surfacePlan?.nextCore) ??
            clean(input.meaningSkeleton?.focus) ??
            clean(input.focus);
          if (!v) return null;
          return /[。！？]$/.test(v) ? v : `${v}。`;
        })(),

      safeLine:
        clean(input.surfacePlan?.safeLine) ??
        (() => {
          const v =
            clean(input.surfacePlan?.safeCore) ??
            (shouldExposeSafeMeaning ? safeMeaningSource : null);
          if (!v) return null;
          return /[。！？]$/.test(v) ? v : `${v}。`;
        })(),
    },

    rules,
  };

  return {
    ...seedWithoutText,
    text: buildSeedText(seedWithoutText),
  };
}


