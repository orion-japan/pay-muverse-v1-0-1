import type {
  CreateIntegrity,
  CreateSource,
  FlowBand,
  PreSeedDecision,
  PreSeedFlowDirective,
  PreSeedFlowDirection,
  PreSeedInputIntent,
  SritcfAxis,
} from './types';

type BuildPreSeedFlowDirectiveArgs = {
  userText: string;
  preSeedDecision?: PreSeedDecision | null;
  decision?: PreSeedDecision | null;
  meta?: any;
  historyForTurn?: any[];
};

function normalizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function compactText(value: unknown): string {
  return normalizeText(value).replace(/[ \t\r\n　]/g, '').toLowerCase();
}

function includesAny(text: string, words: string[]): boolean {
  return words.some((word) => text.includes(word));
}

function getMetaObject(value: any): Record<string, any> {
  return value && typeof value === 'object' ? value : {};
}

function readPreviousDirective(meta: any): any | null {
  const m = getMetaObject(meta);
  const ctxPack = getMetaObject(m.ctxPack ?? m.extra?.ctxPack);
  return (
    ctxPack.preSeedFlowDirective ??
    m.preSeedFlowDirective ??
    m.extra?.preSeedFlowDirective ??
    null
  );
}

function inferInputIntent(userText: string, decision: PreSeedDecision): PreSeedInputIntent {
  const c = compactText(userText);
  const goalKind = String((decision as any).goalKind ?? decision.metaPatch?.goalKind ?? '').trim();
  const followupKind = String((decision as any).followupKind ?? decision.metaPatch?.followupKind ?? '').trim();

  if (goalKind === 'deepen' || /深め|もう少し|詳しく|掘って|見て/u.test(c)) return 'deepen';
  if (goalKind === 'explain_reason' || followupKind === 'reason_detail') return 'explain_reason';
  if (/なぜ|なんで|どうして|理由|根拠/u.test(c)) return 'explain_reason';
  if (/つまり|どういうこと|意味|わかりやすく|言い換え/u.test(c)) return 'clarify';
  if (/違う|ちょっと違う|そうじゃない|修正|ズレ/u.test(c)) return 'correct';
  if (/なんて送|何て送|どう返|文面|文章|メッセージ|言葉にして/u.test(c)) return 'create';
  if (/どうすれば|どうしたら|次に|行動|やること/u.test(c)) return 'ask_action';
  if (/続き|そのまま|このまま/u.test(c)) return 'continue';

  return 'unknown';
}

function inferAxisAndBand(args: {
  userText: string;
  intent: PreSeedInputIntent;
  decision: PreSeedDecision;
}): { currentAxis: SritcfAxis | null; currentBand: FlowBand | null } {
  const c = compactText(args.userText);
  const kind = args.decision.kind;
  const sourceKind = String(args.decision.sourceKind ?? '').trim();

  if (args.intent === 'create' || args.intent === 'ask_action') {
    return { currentAxis: 'C', currentBand: 'RC' };
  }

  if (args.intent === 'explain_reason') {
    return { currentAxis: 'I', currentBand: 'IT' };
  }

  if (args.intent === 'correct') {
    return { currentAxis: 'R', currentBand: 'RC' };
  }

  if (/不安|怖い|つらい|苦しい|焦る|気になる|待つ/u.test(c)) {
    return { currentAxis: 'S', currentBand: 'SF' };
  }

  if (
    kind === 'relationship_reference' ||
    kind === 'person_reference' ||
    /関係|相手|あの人|彼|彼女|みゆ|リナ/u.test(c) ||
    /relationship|person/u.test(sourceKind)
  ) {
    return { currentAxis: 'R', currentBand: 'RC' };
  }

  if (/意図|方向|本当は|結局|核心|大事なのは/u.test(c)) {
    return { currentAxis: 'I', currentBand: 'IT' };
  }

  return { currentAxis: null, currentBand: null };
}

function getSameTargetStreak(meta: any): number {
  const m = getMetaObject(meta);
  const raw =
    m.sameTargetStreak ??
    m.flowMeta?.sameTargetStreak ??
    m.extra?.sameTargetStreak ??
    m.extra?.flowMeta?.sameTargetStreak ??
    0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function getSameGoalStreak(meta: any): number {
  const m = getMetaObject(meta);
  const raw =
    m.sameGoalStreak ??
    m.flowMeta?.sameGoalStreak ??
    m.extra?.sameGoalStreak ??
    m.extra?.flowMeta?.sameGoalStreak ??
    0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function inferIntentionFormed(args: {
  userText: string;
  intent: PreSeedInputIntent;
  currentAxis: SritcfAxis | null;
  currentBand: FlowBand | null;
  previousDirective: any | null;
}): boolean {
  const c = compactText(args.userText);

  if (/意図|方向|核心|本質|結局|わかった|分かった|気づいた|私は/u.test(c)) {
    return true;
  }

  if (args.previousDirective?.intentionFormed === true) {
    return true;
  }

  if (args.previousDirective?.intentionConvergence?.intentionReached === true) {
    return true;
  }

  if (args.currentAxis === 'I' || args.currentBand === 'IT') {
    if (args.intent === 'explain_reason' || args.intent === 'clarify') return true;
  }

  return false;
}

function inferCreateSource(args: {
  userText: string;
  currentAxis: SritcfAxis | null;
  currentBand: FlowBand | null;
}): CreateSource {
  const c = compactText(args.userText);

  if (/不安|怖い|焦る|つらい|苦しい/u.test(c)) return 'S_emotion';
  if (/相手|あの人|彼|彼女|関係|嫌われ|返事|反応/u.test(c)) return 'R_relation';
  if (/意図|方向|自分で|私は|選ぶ|決める/u.test(c)) return 'I_intention';
  if (/気づき|核心|本質|反転|結局/u.test(c)) return 'T_insight';

  if (args.currentAxis === 'C' && args.currentBand === 'RC') return 'R_relation';

  return 'unknown';
}

function inferCreateIntegrity(args: {
  userText: string;
  createSource: CreateSource;
  intentionFormed: boolean;
}): {
  createIntegrity: CreateIntegrity;
  createDistortionRisk: 'none' | 'weak' | 'medium' | 'strong';
  distortionReason: PreSeedFlowDirective['distortionReason'];
} {
  const c = compactText(args.userText);

  if (/嫌われ|怒らせ|見捨て|合わせ|相手が望|相手のため|返事がないから/u.test(c)) {
    return {
      createIntegrity: 'distorted',
      createDistortionRisk: 'strong',
      distortionReason: 'approval_seeking',
    };
  }

  if (/相手の気持ち|本音|絶対|必ず|来ると思|好きですか|どう思って/u.test(c)) {
    return {
      createIntegrity: 'reactive',
      createDistortionRisk: 'medium',
      distortionReason: 'overreading_other',
    };
  }

  if (args.createSource === 'R_relation' && !args.intentionFormed) {
    return {
      createIntegrity: 'partially_aligned',
      createDistortionRisk: 'medium',
      distortionReason: 'relationship_pressure',
    };
  }

  if (args.createSource === 'S_emotion') {
    return {
      createIntegrity: args.intentionFormed ? 'partially_aligned' : 'reactive',
      createDistortionRisk: args.intentionFormed ? 'weak' : 'medium',
      distortionReason: args.intentionFormed ? null : 'fear_based',
    };
  }

  if (args.intentionFormed || args.createSource === 'I_intention' || args.createSource === 'T_insight') {
    return {
      createIntegrity: 'aligned',
      createDistortionRisk: 'none',
      distortionReason: null,
    };
  }

  return {
    createIntegrity: 'unknown',
    createDistortionRisk: 'weak',
    distortionReason: null,
  };
}

function buildWriterSeed(args: {
  shouldLimitDeepening: boolean;
  shouldUseCreate: boolean;
  shouldUseSmallAction: boolean;
  shouldHoldAction: boolean;
  intentionReached: boolean;
  createDistortionRisk: 'none' | 'weak' | 'medium' | 'strong';
}): string | null {
  if (args.shouldHoldAction) {
    return 'このターンでは行動提案を急がず、関係圧や不安反応から出たCreateを小さくし、自分の方向を失っていないかを先に整える。';
  }

  if (args.intentionReached && args.shouldUseSmallAction) {
    return '意図に到達しているため、これ以上の相手分析・原因分析を増やさず、核心を短く言葉にして、小さなCreateまたは実行可能な一手へ収束させる。';
  }

  if (args.intentionReached) {
    return '意図に到達しているため、深掘りを増やしすぎず、核心を短く言葉にして、扱える形へ収束させる。';
  }

  if (args.shouldUseCreate) {
    return '意味を増やしすぎず、ユーザーが扱える小さな言葉・選択肢・構造として仮置きする。';
  }

  if (args.shouldLimitDeepening) {
    return '直前まで十分に分析している可能性があるため、新しい分析を増やしすぎず、既に出た核心を使って短く整理する。';
  }

  return null;
}

export function buildPreSeedFlowDirective(
  args: BuildPreSeedFlowDirectiveArgs
): PreSeedFlowDirective {
  const userText = normalizeText(args.userText);
    const decision = args.preSeedDecision ?? args.decision;

  if (!decision) {
    return {
      source: 'preseed_input_flow',
      inputIntent: 'unknown',
      currentAxis: null,
      currentBand: null,
      flowDirection: 'return_to_input',
      convergenceMode: 'none',
      shouldDeepen: false,
      shouldLimitDeepening: false,
      shouldUseCreate: false,
      shouldUseSmallAction: false,
      shouldHoldAction: false,
      intentionFormed: false,
      tInsightReady: false,
      intentionConvergence: {
        intentionReached: false,
        shouldStopAnalysis: false,
        shouldNameCore: false,
        shouldPlaceCreate: false,
        shouldMoveToSmallAction: false,
        shouldLetFlowContinue: false,
      },
      createReady: false,
      createSource: 'unknown',
      createIntegrity: 'unknown',
      createDistortionRisk: 'weak',
      distortionReason: null,
      seedDirection: {
        targetLabel: null,
        targetType: null,
        flowSeed: 'return_to_input',
        writerSeed: null,
        avoidSeed: ['対象が未確定のため、断定せず入力へ戻す'],
      },
      writerGuidance: {
        mustKeepTarget: false,
        mustNotOverDeepen: false,
        shouldShiftFromAnalysisToPlacement: false,
        shouldOfferSmallCreate: false,
        shouldAvoidOtherMindAssertion: true,
        shouldAvoidLargeAction: true,
        shouldLeaveOpenSpace: true,
      },
      evidence: {
        fromUserInput: ['decision=null'],
        fromFlowMeta: [],
        fromHistory: [],
      },
    };
  }
  const previousDirective = readPreviousDirective(args.meta);

  const inputIntent = inferInputIntent(userText, decision);
  const { currentAxis, currentBand } = inferAxisAndBand({
    userText,
    intent: inputIntent,
    decision,
  });

  const sameTargetStreak = getSameTargetStreak(args.meta);
  const sameGoalStreak = getSameGoalStreak(args.meta);
  const shortInput = userText.length > 0 && userText.length <= 24;

  const intentionFormed = inferIntentionFormed({
    userText,
    intent: inputIntent,
    currentAxis,
    currentBand,
    previousDirective,
  });

  const tInsightReady =
    intentionFormed &&
    currentBand === 'IT' &&
    inputIntent !== 'create' &&
    inputIntent !== 'ask_action';

  const createReady =
    inputIntent === 'create' ||
    inputIntent === 'ask_action' ||
    /どう返|なんて送|何て送|文面|言葉にして|どうすれば|どうしたら/u.test(userText);

  const createSource = inferCreateSource({
    userText,
    currentAxis,
    currentBand,
  });

  const { createIntegrity, createDistortionRisk, distortionReason } = inferCreateIntegrity({
    userText,
    createSource,
    intentionFormed,
  });

  const shouldLimitDeepening =
    intentionFormed ||
    sameTargetStreak >= 3 ||
    sameGoalStreak >= 3 ||
    (shortInput && (inputIntent === 'deepen' || inputIntent === 'continue')) ||
    createReady;

  const shouldDeepen =
    !shouldLimitDeepening &&
    (inputIntent === 'deepen' ||
      inputIntent === 'explain_reason' ||
      inputIntent === 'continue');

  const shouldHoldAction =
    createReady &&
    (createDistortionRisk === 'medium' || createDistortionRisk === 'strong') &&
    createIntegrity !== 'aligned';

  const shouldUseCreate =
    createReady &&
    !shouldHoldAction &&
    (createIntegrity === 'aligned' || createIntegrity === 'partially_aligned');

  const shouldUseSmallAction =
    shouldUseCreate &&
    (createDistortionRisk === 'none' || createDistortionRisk === 'weak');

  let flowDirection: PreSeedFlowDirection = 'continue_observation';

  if (inputIntent === 'correct') {
    flowDirection = 'correct_angle';
  } else if (shouldHoldAction) {
    flowDirection = 'hold_before_create';
  } else if (shouldUseSmallAction) {
    flowDirection = 'let_flow_continue';
  } else if (shouldUseCreate) {
    flowDirection = 'place_create';
  } else if (intentionFormed) {
    flowDirection = 'converge_to_intention';
  } else if (currentAxis === 'R') {
    flowDirection = 'relate_context';
  } else if (currentAxis === 'I') {
    flowDirection = 'name_intention';
  } else if (inputIntent === 'clarify') {
    flowDirection = 'return_to_input';
  }

  const convergenceMode =
    shouldUseSmallAction ? 'toward_small_action' :
    shouldUseCreate ? 'toward_create' :
    intentionFormed ? 'toward_intention' :
    flowDirection === 'let_flow_continue' ? 'toward_flow' :
    'none';

  const intentionReached = intentionFormed && shouldLimitDeepening;

  const writerSeed = buildWriterSeed({
    shouldLimitDeepening,
    shouldUseCreate,
    shouldUseSmallAction,
    shouldHoldAction,
    intentionReached,
    createDistortionRisk,
  });

  const avoidSeed: string[] = [];

  if (shouldLimitDeepening) avoidSeed.push('相手分析・原因分析を増やしすぎない');
  if (shouldHoldAction) avoidSeed.push('関係圧や不安反応から大きな行動へ進めない');
  avoidSeed.push('相手の本心を断定しない');
  avoidSeed.push('大きな行動提案にしない');

  const targetLabel =
    String(
      decision.ctxPackPatch?.memoryTargetLabel ??
        decision.ctxPackPatch?.targetLabel ??
        decision.metaPatch?.targetLabel ??
        decision.sourceKind ??
        ''
    ).trim() || null;

  const targetType =
    String(
      decision.ctxPackPatch?.memorySpace ??
        decision.ctxPackPatch?.targetType ??
        decision.metaPatch?.targetType ??
        decision.kind ??
        ''
    ).trim() || null;

  return {
    source: 'preseed_input_flow',
    inputIntent,
    currentAxis,
    currentBand,
    flowDirection,
    convergenceMode,
    shouldDeepen,
    shouldLimitDeepening,
    shouldUseCreate,
    shouldUseSmallAction,
    shouldHoldAction,
    intentionFormed,
    tInsightReady,
    intentionConvergence: {
      intentionReached,
      shouldStopAnalysis: intentionReached || shouldLimitDeepening,
      shouldNameCore: intentionReached || flowDirection === 'name_intention',
      shouldPlaceCreate: shouldUseCreate,
      shouldMoveToSmallAction: shouldUseSmallAction,
      shouldLetFlowContinue: flowDirection === 'let_flow_continue',
    },
    createReady,
    createSource,
    createIntegrity,
    createDistortionRisk,
    distortionReason,
    seedDirection: {
      targetLabel,
      targetType,
      flowSeed: flowDirection,
      writerSeed,
      avoidSeed,
    },
    writerGuidance: {
      mustKeepTarget: Boolean(targetLabel || targetType),
      mustNotOverDeepen: shouldLimitDeepening,
      shouldShiftFromAnalysisToPlacement: shouldLimitDeepening || shouldUseCreate,
      shouldOfferSmallCreate: shouldUseSmallAction || shouldUseCreate,
      shouldAvoidOtherMindAssertion: true,
      shouldAvoidLargeAction: true,
      shouldLeaveOpenSpace: convergenceMode === 'toward_flow' || shouldUseSmallAction,
    },
    evidence: {
      fromUserInput: [
        `inputIntent=${inputIntent}`,
        currentAxis ? `currentAxis=${currentAxis}` : 'currentAxis=null',
        currentBand ? `currentBand=${currentBand}` : 'currentBand=null',
      ],
      fromFlowMeta: [
        `sameTargetStreak=${sameTargetStreak}`,
        `sameGoalStreak=${sameGoalStreak}`,
        previousDirective?.flowDirection ? `previousFlowDirection=${previousDirective.flowDirection}` : 'previousFlowDirection=null',
      ],
      fromHistory: [],
    },
  };
}






