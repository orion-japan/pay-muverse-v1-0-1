import type { PreSeedDecision } from './types';

export type PreSeedInputIntent =
  | 'deepen'
  | 'explain_reason'
  | 'clarify'
  | 'correct'
  | 'create'
  | 'ask_action'
  | 'continue'
  | 'unknown';

export type PreSeedSritcfAxis = 'S' | 'R' | 'I' | 'T' | 'C' | 'F';
export type PreSeedFlowBand = 'SF' | 'RC' | 'IT';

export type PreSeedFlowDirection =
  | 'continue_observation'
  | 'relate_context'
  | 'name_intention'
  | 't_insight'
  | 'hold_before_create'
  | 'place_create'
  | 'let_flow_continue'
  | 'return_to_input'
  | 'correct_angle'
  | 'explain_basis';

export type PreSeedCreateSource =
  | 'S_emotion'
  | 'R_relation'
  | 'I_intention'
  | 'T_insight'
  | 'unknown';

export type PreSeedCreateIntegrity =
  | 'aligned'
  | 'partially_aligned'
  | 'distorted'
  | 'reactive'
  | 'unknown';

export type PreSeedDistortionRisk = 'none' | 'weak' | 'medium' | 'strong';

export type PreSeedDistortionReason =
  | 'fear_based'
  | 'approval_seeking'
  | 'relationship_pressure'
  | 'false_assumption'
  | 'overreading_other'
  | 'self_abandonment'
  | 'premature_action'
  | null;

export type PreSeedFlowDirective = {
  source: 'preseed_input_flow';

  inputIntent: PreSeedInputIntent;

  currentAxis: PreSeedSritcfAxis | null;
  currentBand: PreSeedFlowBand | null;

  flowDirection: PreSeedFlowDirection;

  shouldDeepen: boolean;
  shouldLimitDeepening: boolean;
  shouldUseCreate: boolean;
  shouldUseSmallAction: boolean;
  shouldHoldAction: boolean;

  intentionFormed: boolean;
  tInsightReady: boolean;

  createReady: boolean;
  createSource: PreSeedCreateSource;
  createIntegrity: PreSeedCreateIntegrity;
  createDistortionRisk: PreSeedDistortionRisk;
  distortionReason?: PreSeedDistortionReason;

  seedDirection: {
    targetLabel?: string | null;
    targetType?: string | null;
    flowSeed?: string | null;
    writerSeed?: string | null;
    avoidSeed?: string[];
  };

  writerGuidance: {
    mustKeepTarget: boolean;
    mustNotOverDeepen: boolean;
    shouldShiftFromAnalysisToPlacement: boolean;
    shouldOfferSmallCreate: boolean;
    shouldAvoidOtherMindAssertion: boolean;
    shouldAvoidLargeAction: boolean;
    shouldLeaveOpenSpace: boolean;
  };

  evidence: {
    fromUserInput: string[];
    fromFlowMeta: string[];
    fromHistory: string[];
  };
};

export type BuildPreSeedFlowDirectiveArgs = {
  userText: string;
  decision?: PreSeedDecision | null;
  meta?: any;
  historyForTurn?: any[];
};

function textOf(v: any): string {
  return String(v ?? '').trim();
}

function compact(v: any): string {
  return textOf(v).replace(/[ \t\r\n　]/g, '').toLowerCase();
}

function has(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function getTurnText(turn: any): string {
  return textOf(
    turn?.content ??
      turn?.text ??
      turn?.assistantText ??
      turn?.message ??
      turn?.body ??
      ''
  );
}

function getTurnMeta(turn: any): any {
  return turn?.meta ?? turn?.metadata ?? turn?.raw?.meta ?? null;
}

function readNested(obj: any, keys: string[]): any {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== 'object') return null;
    current = current[key];
  }
  return current;
}

function getMetaValue(meta: any, key: string): any {
  return (
    meta?.[key] ??
    meta?.extra?.[key] ??
    meta?.ctxPack?.[key] ??
    meta?.extra?.ctxPack?.[key] ??
    null
  );
}

function getDecisionValue(decision: PreSeedDecision | null | undefined, key: string): any {
  return (
    (decision as any)?.[key] ??
    (decision as any)?.metaPatch?.[key] ??
    (decision as any)?.ctxPackPatch?.[key] ??
    (decision as any)?.writerInput?.[key] ??
    null
  );
}

function classifyInputIntent(userText: string): {
  inputIntent: PreSeedInputIntent;
  evidence: string[];
} {
  const c = compact(userText);
  const evidence: string[] = [];

  if (has(c, [/違う/u, /そうじゃない/u, /ちょっと違/u, /修正/u, /ズレ/u])) {
    evidence.push('correction_phrase');
    return { inputIntent: 'correct', evidence };
  }

  if (has(c, [/なんでわか/u, /なぜわか/u, /理由/u, /根拠/u, /どうしてそう/u])) {
    evidence.push('reason_request_phrase');
    return { inputIntent: 'explain_reason', evidence };
  }

  if (has(c, [/文面/u, /文章/u, /言い方/u, /返し方/u, /どう返/u, /どう送/u, /作って/u, /書いて/u, /プロンプト/u])) {
    evidence.push('create_phrase');
    return { inputIntent: 'create', evidence };
  }

  if (has(c, [/どうしたら/u, /何をすれば/u, /次は/u, /行動/u, /やること/u])) {
    evidence.push('action_phrase');
    return { inputIntent: 'ask_action', evidence };
  }

  if (has(c, [/つまり/u, /どういう意味/u, /どういうこと/u, /わかりやすく/u, /整理/u])) {
    evidence.push('clarify_phrase');
    return { inputIntent: 'clarify', evidence };
  }

  if (has(c, [/続き/u, /この続き/u, /続きを/u])) {
    evidence.push('continue_phrase');
    return { inputIntent: 'continue', evidence };
  }

  if (has(c, [/深め/u, /詳しく/u, /もう少し/u, /見てください/u, /分析/u, /読み解/u])) {
    evidence.push('deepen_phrase');
    return { inputIntent: 'deepen', evidence };
  }

  return { inputIntent: 'unknown', evidence };
}

function axisFromDepthStage(depthStage: any): PreSeedSritcfAxis | null {
  const s = textOf(depthStage).toUpperCase();
  const first = s.charAt(0);
  if (first === 'S' || first === 'R' || first === 'I' || first === 'T' || first === 'C' || first === 'F') {
    return first as PreSeedSritcfAxis;
  }
  return null;
}

function axisFromSpin(spinLoop: any, spinStep: any): PreSeedSritcfAxis | null {
  const loop = textOf(spinLoop).toUpperCase();
  const step = Number(spinStep);
  if (loop === 'SRI') return step === 0 ? 'S' : step === 1 ? 'R' : step === 2 ? 'I' : null;
  if (loop === 'TCF') return step === 0 ? 'T' : step === 1 ? 'C' : step === 2 ? 'F' : null;
  return null;
}

function bandFromAxis(axis: PreSeedSritcfAxis | null): PreSeedFlowBand | null {
  if (axis === 'S' || axis === 'F') return 'SF';
  if (axis === 'R' || axis === 'C') return 'RC';
  if (axis === 'I' || axis === 'T') return 'IT';
  return null;
}

function resolveAxisAndBand(args: BuildPreSeedFlowDirectiveArgs): {
  axis: PreSeedSritcfAxis | null;
  band: PreSeedFlowBand | null;
  evidence: string[];
} {
  const meta = args.meta ?? {};
  const decision = args.decision ?? null;

  const depthStage =
    getMetaValue(meta, 'depthStage') ??
    getMetaValue(meta, 'depth_stage') ??
    getDecisionValue(decision, 'depthStage') ??
    getDecisionValue(decision, 'depth_stage');

  const spinLoop =
    getMetaValue(meta, 'spinLoop') ??
    getMetaValue(meta, 'spin_loop') ??
    getDecisionValue(decision, 'spinLoop');

  const spinStep =
    getMetaValue(meta, 'spinStep') ??
    getMetaValue(meta, 'spin_step') ??
    getDecisionValue(decision, 'spinStep');

  const fromDepth = axisFromDepthStage(depthStage);
  const fromSpin = axisFromSpin(spinLoop, spinStep);
  const axis = fromDepth ?? fromSpin;
  const band = bandFromAxis(axis);
  const evidence: string[] = [];

  if (fromDepth) evidence.push(`depthStage:${textOf(depthStage)}`);
  if (fromSpin) evidence.push(`spin:${textOf(spinLoop)}:${textOf(spinStep)}`);
  if (band) evidence.push(`flowBand:${band}`);

  return { axis, band, evidence };
}

function extractTargetLabel(decision: PreSeedDecision | null | undefined, meta: any): string | null {
  return textOf(
    getDecisionValue(decision, 'targetLabel') ??
      getDecisionValue(decision, 'memoryTargetLabel') ??
      getDecisionValue(decision, 'diagnosisFollowupTargetLabel') ??
      getMetaValue(meta, 'targetLabel') ??
      getMetaValue(meta, 'memoryTargetLabel') ??
      ''
  ) || null;
}

function estimateHistory(args: BuildPreSeedFlowDirectiveArgs, targetLabel: string | null): {
  sameTargetStreak: number;
  analysisHeavyStreak: number;
  recentGoalStreak: number;
  evidence: string[];
} {
  const history = Array.isArray(args.historyForTurn) ? args.historyForTurn.slice(-6) : [];
  const targetKey = compact(targetLabel ?? '');
  let sameTargetStreak = 0;
  let analysisHeavyStreak = 0;
  let recentGoalStreak = 0;
  const evidence: string[] = [];

  for (const turn of history.slice().reverse()) {
    const meta = getTurnMeta(turn) ?? {};
    const txt = getTurnText(turn);
    const turnTarget = compact(
      getMetaValue(meta, 'targetLabel') ??
        getMetaValue(meta, 'memoryTargetLabel') ??
        getMetaValue(meta, 'diagnosisFollowupTargetLabel') ??
        ''
    );

    if (targetKey && turnTarget && (turnTarget === targetKey || turnTarget.includes(targetKey) || targetKey.includes(turnTarget))) {
      sameTargetStreak += 1;
    } else if (sameTargetStreak > 0) {
      break;
    }

    const goal = compact(getMetaValue(meta, 'goalKind') ?? getMetaValue(meta, 'targetKind') ?? '');
    if (/deepen|explain|diagnosis|analysis|detail|深め|理由/u.test(goal)) {
      recentGoalStreak += 1;
    }

    if (txt.length >= 180 || /核心|構造|意味|状態|関係|意図|本音|相手/u.test(txt)) {
      analysisHeavyStreak += 1;
    }
  }

  if (sameTargetStreak > 0) evidence.push(`sameTargetStreak:${sameTargetStreak}`);
  if (analysisHeavyStreak > 0) evidence.push(`analysisHeavyStreak:${analysisHeavyStreak}`);
  if (recentGoalStreak > 0) evidence.push(`recentGoalStreak:${recentGoalStreak}`);

  return { sameTargetStreak, analysisHeavyStreak, recentGoalStreak, evidence };
}

function estimateIntention(args: {
  userText: string;
  axis: PreSeedSritcfAxis | null;
  band: PreSeedFlowBand | null;
  meta: any;
  decision?: PreSeedDecision | null;
}): { intentionFormed: boolean; tInsightReady: boolean; evidence: string[] } {
  const c = compact(args.userText);
  const evidence: string[] = [];
  const hasIntentionWords = has(c, [/意図/u, /方向/u, /選びたい/u, /どうありたい/u, /大事/u, /本当は/u, /決めたい/u]);
  const hasTWords = has(c, [/気づき/u, /前提/u, /そもそも/u, /反転/u, /見方/u, /視点/u]);

  const metaIntentLine =
    getMetaValue(args.meta, 'intentLine') ??
    getDecisionValue(args.decision, 'intentLine') ??
    readNested(args.meta, ['extra', 'intentLine']);

  const intentionFormed = Boolean(
    hasIntentionWords ||
      args.axis === 'I' ||
      args.axis === 'T' ||
      args.band === 'IT' ||
      metaIntentLine?.coreNeed ||
      metaIntentLine?.direction ||
      getMetaValue(args.meta, 'intentionFormed')
  );

  const tInsightReady = Boolean(
    intentionFormed &&
      (hasTWords || args.axis === 'T' || getMetaValue(args.meta, 'tLayerModeActive') || getMetaValue(args.meta, 'tLayerHint'))
  );

  if (hasIntentionWords) evidence.push('intention_words');
  if (hasTWords) evidence.push('t_insight_words');
  if (args.band === 'IT') evidence.push('band:IT');
  if (metaIntentLine?.coreNeed || metaIntentLine?.direction) evidence.push('meta:intentLine');

  return { intentionFormed, tInsightReady, evidence };
}

function estimateCreate(args: {
  userText: string;
  inputIntent: PreSeedInputIntent;
  axis: PreSeedSritcfAxis | null;
  band: PreSeedFlowBand | null;
  intentionFormed: boolean;
  tInsightReady: boolean;
  meta: any;
}): {
  createReady: boolean;
  createSource: PreSeedCreateSource;
  createIntegrity: PreSeedCreateIntegrity;
  createDistortionRisk: PreSeedDistortionRisk;
  distortionReason: PreSeedDistortionReason;
  evidence: string[];
} {
  const c = compact(args.userText);
  const evidence: string[] = [];

  const createReady = Boolean(
    args.inputIntent === 'create' ||
      args.inputIntent === 'ask_action' ||
      has(c, [/言葉/u, /文面/u, /文章/u, /形/u, /構造/u, /作/u, /送/u, /返/u, /行動/u]) ||
      getMetaValue(args.meta, 'createReady')
  );

  const emotionRisk = has(c, [/不安/u, /怖/u, /焦/u, /苦しい/u, /寂しい/u, /希望がない/u]);
  const relationSignal = has(c, [/相手/u, /関係/u, /LINE/u, /ライン/u, /会話/u, /返事/u, /嫌われ/u, /合わせ/u, /期待/u, /場/u]);
  const approvalRisk = has(c, [/嫌われ/u, /好かれ/u, /合わせ/u, /期待に応/u, /怒らせ/u, /失いたくない/u]);
  const overreadRisk = has(c, [/相手.*気持/u, /相手.*本音/u, /どう思/u, /思っている/u]);
  const selfAbandonRisk = has(c, [/自分.*我慢/u, /自分.*抑/u, /私が悪/u, /合わせるしか/u]);

  let createSource: PreSeedCreateSource = 'unknown';
  if (args.tInsightReady) createSource = 'T_insight';
  else if (args.intentionFormed) createSource = 'I_intention';
  else if (relationSignal || args.band === 'RC' || args.axis === 'R') createSource = 'R_relation';
  else if (emotionRisk || args.band === 'SF' || args.axis === 'S') createSource = 'S_emotion';

  let createDistortionRisk: PreSeedDistortionRisk = 'none';
  let distortionReason: PreSeedDistortionReason = null;
  let createIntegrity: PreSeedCreateIntegrity = 'unknown';

  if (approvalRisk) {
    createDistortionRisk = 'strong';
    distortionReason = 'approval_seeking';
  } else if (selfAbandonRisk) {
    createDistortionRisk = 'strong';
    distortionReason = 'self_abandonment';
  } else if (createSource === 'R_relation' && overreadRisk) {
    createDistortionRisk = 'medium';
    distortionReason = 'overreading_other';
  } else if (createSource === 'R_relation') {
    createDistortionRisk = 'weak';
    distortionReason = 'relationship_pressure';
  } else if (createSource === 'S_emotion' && emotionRisk) {
    createDistortionRisk = 'medium';
    distortionReason = 'fear_based';
  }

  if (createSource === 'T_insight' || createSource === 'I_intention') {
    createIntegrity = createDistortionRisk === 'none' ? 'aligned' : 'partially_aligned';
  } else if (createSource === 'R_relation' && createDistortionRisk !== 'none') {
    createIntegrity = createDistortionRisk === 'strong' ? 'distorted' : 'partially_aligned';
  } else if (createSource === 'S_emotion' && createDistortionRisk !== 'none') {
    createIntegrity = 'reactive';
  } else if (createReady) {
    createIntegrity = 'partially_aligned';
  }

  if (createReady) evidence.push('create_ready_signal');
  if (relationSignal) evidence.push('relation_create_signal');
  if (emotionRisk) evidence.push('emotion_create_signal');
  if (distortionReason) evidence.push(`distortion:${distortionReason}`);

  return { createReady, createSource, createIntegrity, createDistortionRisk, distortionReason, evidence };
}

function raiseRisk(base: PreSeedDistortionRisk, next: PreSeedDistortionRisk): PreSeedDistortionRisk {
  const order: PreSeedDistortionRisk[] = ['none', 'weak', 'medium', 'strong'];
  return order[Math.max(order.indexOf(base), order.indexOf(next))] ?? base;
}

function buildWriterSeed(args: {
  flowDirection: PreSeedFlowDirection;
  shouldLimitDeepening: boolean;
  createSource: PreSeedCreateSource;
  createDistortionRisk: PreSeedDistortionRisk;
  distortionReason: PreSeedDistortionReason;
  tInsightReady: boolean;
}): string {
  if (args.flowDirection === 'explain_basis') {
    return '根拠説明のターン。新しい見立てを増やしすぎず、なぜそう読んだかだけを短く説明する。';
  }
  if (args.flowDirection === 'correct_angle') {
    return '修正ターン。対象は保ち、深掘りを続けず、角度を変えて短く置き直す。';
  }
  if (args.createDistortionRisk === 'medium' || args.createDistortionRisk === 'strong') {
    return 'Createに歪みリスクあり。相手反応に合わせた大きな行動にせず、自分の方向を保つ小さな言葉へ縮める。';
  }
  if (args.tInsightReady) {
    return 'Tは深掘り回避ではなく、意図を通した深い気づきとして短く通す。結論で閉じず、Cに置ける余白を残す。';
  }
  if (args.flowDirection === 'place_create') {
    return '意味を増やしすぎず、ユーザーが扱える小さな言葉・選択肢・構造として仮置きする。';
  }
  if (args.flowDirection === 'let_flow_continue') {
    return '長く説明せず、置いたものが流れ始めるように短く余白を残す。';
  }
  if (args.shouldLimitDeepening) {
    return '直前まで十分に分析しているため、新しい分析を増やしすぎず、既に出た核心を使って短く整理する。';
  }
  return 'ユーザー入力とフローメタを優先し、LLMの深読みだけで次の進行を決めない。';
}

export function buildPreSeedFlowDirective(args: BuildPreSeedFlowDirectiveArgs): PreSeedFlowDirective {
  const userText = textOf(args.userText);
  const meta = args.meta ?? {};
  const decision = args.decision ?? null;
  const input = classifyInputIntent(userText);
  const axisBand = resolveAxisAndBand(args);
  const targetLabel = extractTargetLabel(decision, meta);
  const history = estimateHistory(args, targetLabel);
  const intention = estimateIntention({
    userText,
    axis: axisBand.axis,
    band: axisBand.band,
    meta,
    decision,
  });
  const create = estimateCreate({
    userText,
    inputIntent: input.inputIntent,
    axis: axisBand.axis,
    band: axisBand.band,
    intentionFormed: intention.intentionFormed,
    tInsightReady: intention.tInsightReady,
    meta,
  });

  let loopRisk: PreSeedDistortionRisk = 'none';
  const flowEvidence: string[] = [...axisBand.evidence];
  const historyEvidence: string[] = [...history.evidence];

  if ((input.inputIntent === 'deepen' || input.inputIntent === 'explain_reason') && history.recentGoalStreak >= 2) {
    loopRisk = raiseRisk(loopRisk, 'medium');
    historyEvidence.push('same_goal_deepening_repeated');
  }
  if (history.sameTargetStreak >= 2 && history.analysisHeavyStreak >= 2) {
    loopRisk = raiseRisk(loopRisk, 'medium');
    historyEvidence.push('same_target_analysis_heavy');
  }
  if ((axisBand.axis === 'R' || axisBand.axis === 'I' || axisBand.band === 'RC' || axisBand.band === 'IT') && history.analysisHeavyStreak >= 2) {
    loopRisk = raiseRisk(loopRisk, 'weak');
    flowEvidence.push('axis_or_band_analysis_streak');
  }

  const shouldLimitDeepening =
    loopRisk === 'medium' ||
    loopRisk === 'strong' ||
    (input.inputIntent === 'create' && history.analysisHeavyStreak >= 1) ||
    (input.inputIntent === 'ask_action' && history.analysisHeavyStreak >= 1);

  const shouldHoldAction = Boolean(
    create.createReady &&
      (create.createDistortionRisk === 'medium' || create.createDistortionRisk === 'strong')
  );

  const shouldUseCreate = Boolean(
    create.createReady && !shouldHoldAction && create.createIntegrity !== 'distorted' && create.createIntegrity !== 'reactive'
  );

  const shouldUseSmallAction = Boolean(
    create.createReady &&
      (shouldUseCreate || shouldHoldAction || create.createDistortionRisk !== 'none')
  );

  const shouldDeepen = Boolean(
    !shouldLimitDeepening &&
      !create.createReady &&
      (input.inputIntent === 'deepen' || input.inputIntent === 'continue' || input.inputIntent === 'unknown') &&
      !intention.tInsightReady
  );

  let flowDirection: PreSeedFlowDirection = 'continue_observation';
  if (input.inputIntent === 'correct') flowDirection = 'correct_angle';
  else if (input.inputIntent === 'explain_reason') flowDirection = 'explain_basis';
  else if (shouldHoldAction) flowDirection = 'hold_before_create';
  else if (shouldUseCreate) flowDirection = 'place_create';
  else if (intention.tInsightReady) flowDirection = 't_insight';
  else if (shouldLimitDeepening && intention.intentionFormed) flowDirection = 'name_intention';
  else if (axisBand.axis === 'R' || axisBand.band === 'RC') flowDirection = 'relate_context';
  else if (axisBand.axis === 'F') flowDirection = 'let_flow_continue';
  else if (input.inputIntent === 'clarify') flowDirection = 'return_to_input';

  const writerSeed = buildWriterSeed({
    flowDirection,
    shouldLimitDeepening,
    createSource: create.createSource,
    createDistortionRisk: create.createDistortionRisk,
    distortionReason: create.distortionReason,
    tInsightReady: intention.tInsightReady,
  });

  const avoidSeed: string[] = [];
  if (shouldLimitDeepening) avoidSeed.push('同じ分析をさらに積み増さない');
  if (create.createDistortionRisk !== 'none') avoidSeed.push('相手の心を断定しない');
  if (shouldHoldAction) avoidSeed.push('大きな行動提案にしない');
  if (input.inputIntent === 'explain_reason') avoidSeed.push('新しい診断に広げない');

  return {
    source: 'preseed_input_flow',
    inputIntent: input.inputIntent,
    currentAxis: axisBand.axis,
    currentBand: axisBand.band,
    flowDirection,
    shouldDeepen,
    shouldLimitDeepening,
    shouldUseCreate,
    shouldUseSmallAction,
    shouldHoldAction,
    intentionFormed: intention.intentionFormed,
    tInsightReady: intention.tInsightReady,
    createReady: create.createReady,
    createSource: create.createSource,
    createIntegrity: create.createIntegrity,
    createDistortionRisk: create.createDistortionRisk,
    distortionReason: create.distortionReason,
    seedDirection: {
      targetLabel,
      targetType: textOf(getDecisionValue(decision, 'targetType') ?? getMetaValue(meta, 'targetType')) || null,
      flowSeed: flowDirection,
      writerSeed,
      avoidSeed,
    },
    writerGuidance: {
      mustKeepTarget: Boolean(targetLabel || decision?.kind !== 'normal_chat'),
      mustNotOverDeepen: shouldLimitDeepening,
      shouldShiftFromAnalysisToPlacement: Boolean(shouldUseCreate || (shouldLimitDeepening && intention.intentionFormed)),
      shouldOfferSmallCreate: shouldUseSmallAction,
      shouldAvoidOtherMindAssertion: create.createDistortionRisk !== 'none' || create.createSource === 'R_relation',
      shouldAvoidLargeAction: shouldHoldAction || create.createDistortionRisk !== 'none',
      shouldLeaveOpenSpace: flowDirection === 't_insight' || flowDirection === 'let_flow_continue' || shouldHoldAction,
    },
    evidence: {
      fromUserInput: [...input.evidence, ...intention.evidence, ...create.evidence],
      fromFlowMeta: flowEvidence,
      fromHistory: historyEvidence,
    },
  };
}
