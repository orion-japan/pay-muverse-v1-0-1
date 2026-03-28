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

export type SeedCanonicalInput = {
  meaningSkeleton?: MeaningSkeletonV2 | null;
  flow180?: Flow180Like | null;

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
};

export type SeedCanonical = {
  focus: string;
  tone: SeedTone;
  depth: SeedDepth;
  pressure: string;
  relationContext?: string | null;
  oneLineConstraint: string;

  meaning: string;
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

  meta: {
    goalKind: string | null;
    depthStage: string | null;
    phase: string | null;
    qCode: string | null;
    eTurn: string | null;
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
    clean(input.flow180?.sentence) &&
    !isCommand(clean(input.flow180?.sentence))
      ? clean(input.flow180?.sentence)
      : null;

  const fromDeltaLine =
    clean(input.writerDirectives?.deltaLine) &&
    !isCommand(clean(input.writerDirectives?.deltaLine))
      ? clean(input.writerDirectives?.deltaLine)
      : null;

  return (
    explicitMeaning ??
    structuralMeaning ??
    cleanTransition ??
    fromFlow180 ??
    fromDeltaLine ??
    '今回の返答は一点に収束させる'
  );
}

function buildFocus(input: SeedCanonicalInput): string {
  const fromInputFocus = clean(input.focus);
  if (fromInputFocus) return fromInputFocus;

  const fromUserCore = clean(input.userCore);
  if (fromUserCore) return fromUserCore;

  const fromSkeletonFocus = clean(input.meaningSkeleton?.focus);
  if (fromSkeletonFocus) return fromSkeletonFocus;

  const fromDeltaLine = clean(input.writerDirectives?.deltaLine);
  if (fromDeltaLine) return fromDeltaLine;

  return '今回の焦点を一つに絞る';
}

function buildRelationContext(input: SeedCanonicalInput): string | null {
  return clean(input.meaningSkeleton?.relationContext);
}

function buildOneLineConstraint(input: SeedCanonicalInput): string {
  const fromSkeleton = clean(input.meaningSkeleton?.oneLineConstraint);
  if (fromSkeleton) return fromSkeleton;

  const pieces = [
    '1核心',
    '説明を増やさない',
    '同一テーマ内での視点の深掘りは許可',
  ];

  const askBackAllowed = input.askBackAllowed === true;
  const questionsMax =
    typeof input.questionsMax === 'number' ? input.questionsMax : null;

  if (!askBackAllowed || questionsMax === 0) {
    pieces.push('質問しない');
  }

  return pieces.join(' / ');
}

function buildRules(input: SeedCanonicalInput): string[] {
  const base = uniqueStrings(input.writerDirectives?.writeConstraints ?? []);
  const out = [...base];

  const hasNoQuestion = out.some((v) => /質問しない/.test(v));

  const askBackAllowed = input.askBackAllowed === true;
  const questionsMax =
    typeof input.questionsMax === 'number' ? input.questionsMax : null;

  if ((!askBackAllowed || questionsMax === 0) && !hasNoQuestion) {
    out.push('質問しない');
  }

  if (clean(input.goalKind) === 'stabilize') {
    if (!out.some((v) => /新しい論点/.test(v))) {
      out.push('新しい論点を増やさない');
    }
  }

  return out;
}

function buildSeedText(seed: Omit<SeedCanonical, 'text'>): string {
  const stateFlow = compactLines([
    seed.state.from ? `from=${seed.state.from}` : null,
    seed.state.to ? `to=${seed.state.to}` : null,
    seed.state.flow ? `flow=${seed.state.flow}` : null,
    seed.state.deltaType ? `deltaType=${seed.state.deltaType}` : null,
  ]);

  const context = compactLines([
    seed.context.userCore ? `userCore=${seed.context.userCore}` : null,
    seed.context.historyLine ? `historyLine=${seed.context.historyLine}` : null,
  ]);

  const meta = compactLines([
    seed.meta.goalKind ? `goalKind=${seed.meta.goalKind}` : null,
    seed.meta.depthStage ? `depthStage=${seed.meta.depthStage}` : null,
    seed.meta.phase ? `phase=${seed.meta.phase}` : null,
    seed.meta.qCode ? `qCode=${seed.meta.qCode}` : null,
    seed.meta.eTurn ? `e_turn=${seed.meta.eTurn}` : null,
  ]);

  const rules =
    seed.rules.length > 0
      ? seed.rules.map((rule) => `- ${rule}`).join('\n')
      : '- 質問しない';

  return compactLines([
    'SEED (DO NOT OUTPUT):',
    '',
    'MEANING:',
    seed.meaning,
    '',
    'FOCUS:',
    seed.focus,
    '',
    'TONE:',
    seed.tone,
    '',
    'DEPTH:',
    seed.depth,
    '',
    'PRESSURE:',
    seed.pressure,
    '',
    seed.relationContext ? 'RELATION_CONTEXT:' : null,
    seed.relationContext ?? null,
    seed.relationContext ? '' : null,
    'ONE_LINE_CONSTRAINT:',
    seed.oneLineConstraint,
    '',
    'STATE:',
    stateFlow,
    '',
    'CONTEXT:',
    context,
    '',
    'META:',
    meta,
    '',
    'RULES:',
    rules,
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
    flowSentence,
    deltaLine,
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
    flowSentence ||
    deltaLine ||
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
          '現実側に寄る方向';

        return `本当は「${b}」ほうに寄っていると、もう分かっている`;
      })()
    : baseMeaning;

  const seedWithoutText: Omit<SeedCanonical, 'text'> = {
    focus,
    tone,
    depth,
    pressure,
    relationContext,
    oneLineConstraint,

    meaning,

    state: {
      from: clean(input.flow180?.from) ?? clean(input.writerDirectives?.flowFrom),
      to: clean(input.flow180?.to) ?? clean(input.writerDirectives?.flowTo),
      flow: clean(input.flow180?.primary) ?? clean(input.flow180?.sentence),
      deltaType: clean(input.flow180?.deltaType),
    },

    context: {
      userCore: clean(input.userCore) ?? clean(input.focus),
      historyLine: clean(input.historyLine),
    },

    meta: {
      goalKind,
      depthStage: clean(input.depthStage),
      phase: clean(input.phase),
      qCode: clean(input.qCode),
      eTurn: clean(input.eTurn),
    },

    rules,
  };

  return {
    ...seedWithoutText,
    text: buildSeedText(seedWithoutText),
  };
}
