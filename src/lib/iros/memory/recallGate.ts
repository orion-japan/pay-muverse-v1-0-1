// src/lib/iros/memory/recallGate.ts
// iros — Recall Gate v1
// 目的:
// - 「記憶がある」から「今回使ってよいか」を判定に変える
// - 状態 / flow / question / 候補メモリーをまとめて見て、writer に渡す前の判断を返す
// - ここでは “選定” ではなく “許可と範囲” を決める
//
// 注意:
// - まだ DB や selector には触れない
// - まずは pure function として安全に導入する
// - 詳細 recall 文面は別層（buildMemoryDecision / buildRecallHook）で扱う

export type RecallScope =
  | 'none'
  | 'recent_turn_only'
  | 'recent_topic'
  | 'state_only'
  | 'durable_only'
  | 'episodic_only'
  | 'mixed';

export type RecallMode = 'implicit' | 'explicit' | 'forbidden';
export type RecallSafety = 'strict' | 'normal' | 'open';

export type RecallDecision = {
  recallEligible: boolean;
  recallScope: RecallScope;
  recallReason: string;
  recallMode: RecallMode;
  recallSafety: RecallSafety;
  selectedSources: string[];
  evidenceScore: number;
  disallowReason?: string | null;
};

export type RecallGateInput = {
  userText: string;

  // state
  depthStage?: string | null;
  qCode?: string | null;
  phase?: string | null;
  intentAnchor?: string | null;
  selfAcceptance?: number | null;

  // flow
  flowDelta?: string | null;
  returnStreak?: number | null;
  stingLevel?: string | null;
  flowDigest?: string | null;

  // question/meta
  questionType?: string | null;
  questionDomain?: string | null;
  tLayerHint?: string | null;
  itxStep?: string | null;
  itTriggered?: boolean | null;
  outputPolicy?: {
    answerFirst?: boolean;
    askBackAllowed?: boolean;
    splitFactHypothesis?: boolean;
    usePastReframe?: boolean;
    avoidPrematureClosure?: boolean;
  } | null;

  // short memory / continuity
  topicDigest?: string | null;
  conversationLine?: string | null;
  historyForWriterLen?: number | null;
  historyDigestTopic?: string | null;
  historyDigestSummary?: string | null;
  hasPastStateNoteText?: boolean;

  // durable / episodic candidate presence
  longTermMemoryTypes?: string[] | null;
  hasEpisodicCandidate?: boolean;
};

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function lower(v: unknown): string {
  return norm(v).toLowerCase();
}

function hasJaText(v: unknown): boolean {
  return norm(v).length > 0;
}

function includesLoose(base: string, candidate: string): boolean {
  if (!base || !candidate) return false;
  if (base.includes(candidate)) return true;
  if (candidate.includes(base)) return true;
  return false;
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs.filter(Boolean)));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function pickQuestionKindScore(questionType: string | null | undefined): {
  score: number;
  reason: string | null;
} {
  const qt = lower(questionType);

  if (!qt) return { score: 0, reason: null };

  if (qt.includes('future_design')) {
    return { score: 0.22, reason: 'future_design' };
  }
  if (qt.includes('clarify')) {
    return { score: 0.22, reason: 'clarify' };
  }
  if (qt.includes('past_resolve')) {
    return { score: 0.26, reason: 'past_resolve' };
  }
  if (qt.includes('meaning')) {
    return { score: 0.18, reason: 'meaning' };
  }

  return { score: 0.06, reason: 'question_type_weak' };
}
function pickTModeScore(args: RecallGateInput): {
  score: number;
  reason: string | null;
} {
  const tLayerHint = lower(args.tLayerHint);
  const itxStep = lower(args.itxStep);
  const itTriggered = Boolean(args.itTriggered);
  const questionType = lower(args.questionType);
  const flowDelta = lower(args.flowDelta);

  let score = 0;
  let reason: string | null = null;

  if (itTriggered) {
    score += 0.12;
    reason = 'it_triggered';
  }

  if (tLayerHint.startsWith('t')) {
    score += 0.12;
    reason = reason ?? 't_layer_hint';
  }

  if (itxStep.startsWith('t')) {
    score += 0.1;
    reason = reason ?? 'itx_step_t';
  }

  if ((tLayerHint.startsWith('t') || itxStep.startsWith('t')) && questionType.includes('future_design')) {
    score += 0.14;
    reason = 't_future_design';
  }

  if ((tLayerHint.startsWith('t') || itxStep.startsWith('t')) && flowDelta === 'forward') {
    score += 0.08;
    reason = reason ?? 't_forward';
  }

  return {
    score: clamp01(score),
    reason,
  };
}
function pickFlowScore(args: RecallGateInput): {
  score: number;
  reason: string | null;
} {
  const delta = lower(args.flowDelta);
  const returnStreak = Number(args.returnStreak ?? 0);
  const stingLevel = lower(args.stingLevel);
  const qCode = lower(args.qCode);
  const depthStage = lower(args.depthStage);

  let score = 0;
  let reason: string | null = null;

  // RETURN は「過去を掘る」ではなく「直近の整理」に強く寄せる
  if (delta === 'return') {
    score += 0.18;
    reason = 'flow_return';
    if (returnStreak >= 3) score += 0.08;
    if (returnStreak >= 5) score += 0.06;
  }

  if (stingLevel === 'high') {
    score += 0.08;
    reason = reason ?? 'sting_high';
  }

  // S1/Q3 付近は深掘りより安全確認・輪郭確認に寄る
  if (qCode === 'q3') score += 0.06;
  if (depthStage.startsWith('s')) score += 0.05;

  return {
    score: clamp01(score),
    reason,
  };
}

function pickContinuityScore(args: RecallGateInput): {
  score: number;
  reason: string | null;
} {
  const userText = norm(args.userText);
  const topicDigest = norm(args.topicDigest);
  const conversationLine = norm(args.conversationLine);
  const historyDigestTopic = norm(args.historyDigestTopic);
  const historyDigestSummary = norm(args.historyDigestSummary);
  const hfwLen = Number(args.historyForWriterLen ?? 0);

  let score = 0;
  let reason: string | null = null;

  if (hfwLen > 0) {
    score += 0.12;
    reason = 'history_present';
  }
  if (hfwLen >= 2) {
    score += 0.06;
    reason = reason ?? 'history_present';
  }

  if (hasJaText(topicDigest) && includesLoose(userText, topicDigest)) {
    score += 0.24;
    reason = 'topic_continuity';
  } else if (hasJaText(conversationLine) && includesLoose(userText, conversationLine)) {
    score += 0.18;
    reason = 'conversation_continuity';
  } else if (
    hasJaText(historyDigestTopic) &&
    (includesLoose(userText, historyDigestTopic) || includesLoose(topicDigest, historyDigestTopic))
  ) {
    score += 0.18;
    reason = 'digest_topic_continuity';
  } else if (
    hasJaText(historyDigestSummary) &&
    (includesLoose(userText, historyDigestSummary) || includesLoose(topicDigest, historyDigestSummary))
  ) {
    score += 0.12;
    reason = 'digest_summary_continuity';
  }

  return {
    score: clamp01(score),
    reason,
  };
}

function pickMemorySourceScore(args: RecallGateInput): {
  score: number;
  reason: string | null;
  selectedSources: string[];
} {
  const longTypes = Array.isArray(args.longTermMemoryTypes) ? args.longTermMemoryTypes.map(lower) : [];
  const hasPastStateNoteText = Boolean(args.hasPastStateNoteText);
  const hasEpisodicCandidate = Boolean(args.hasEpisodicCandidate);

  let score = 0;
  let reason: string | null = null;
  const selectedSources: string[] = [];

  if (hasPastStateNoteText) {
    score += 0.08;
    selectedSources.push('recall_snapshot');
    reason = 'past_state_note';
  }

  if (longTypes.length > 0) {
    score += 0.08;
    selectedSources.push('long_term');
    reason = reason ?? 'long_term_present';
  }

  if (longTypes.includes('working_rule')) {
    score += 0.04;
    selectedSources.push('working_rule');
    reason = reason ?? 'working_rule_match';
  }

  if (longTypes.includes('project_context')) {
    score += 0.05;
    selectedSources.push('project_context');
    reason = reason ?? 'project_match';
  }

  if (longTypes.includes('durable_fact')) {
    score += 0.03;
    selectedSources.push('durable_fact');
    reason = reason ?? 'durable_match';
  }

  if (hasEpisodicCandidate || longTypes.includes('episodic_event')) {
    score += 0.12;
    selectedSources.push('episodic_event');
    reason = reason ?? 'episodic_match';
  }

  return {
    score: clamp01(score),
    reason,
    selectedSources: uniq(selectedSources),
  };
}

function decideScope(args: RecallGateInput, evidenceScore: number, selectedSources: string[]): RecallScope {
  const delta = lower(args.flowDelta);
  const qt = lower(args.questionType);
  const hfwLen = Number(args.historyForWriterLen ?? 0);
  const hasEpisodic = selectedSources.includes('episodic_event');
  const hasLongTerm = selectedSources.includes('long_term');
  const hasWorkingRule = selectedSources.includes('working_rule');

  const tLayerHint = lower(args.tLayerHint);
  const itxStep = lower(args.itxStep);
  const itTriggered = Boolean(args.itTriggered);
  const usePastReframe = Boolean(args.outputPolicy?.usePastReframe);

  const hasTSignal = itTriggered || tLayerHint.startsWith('t') || itxStep.startsWith('t');
  const returnish = delta === 'return' || Number(args.returnStreak ?? 0) >= 1;
  const episodicOpenOk =
    hasEpisodic &&
    hasTSignal &&
    (
      returnish ||
      usePastReframe ||
      qt.includes('past_resolve') ||
      qt.includes('compare') ||
      qt.includes('reflection')
    );

  if (evidenceScore < 0.35) return 'none';

  // 開発相談では working_rule を使う余地があるが、この層ではまだ broad に durable 扱い
  if (hasWorkingRule && qt.includes('implement')) return 'durable_only';

  // RETURN は、まず直近から扱う
  if (delta === 'return' && hfwLen > 0) return 'recent_turn_only';

  // future_design は通常は recent/state 側に寄せる
  // ただし episodicOpenOk の時だけ episodic を許可する
  if ((qt.includes('future_design') || qt.includes('clarify') || qt.includes('meaning')) && hfwLen > 0) {
    if (episodicOpenOk) {
      return hasLongTerm ? 'mixed' : 'episodic_only';
    }
    return 'recent_turn_only';
  }

  if (episodicOpenOk) {
    if (hasLongTerm && hfwLen > 0) return 'mixed';
    if (hasLongTerm && hfwLen <= 0) return 'mixed';
    return 'episodic_only';
  }

  if (hasEpisodic && !hasLongTerm && hfwLen <= 0) return 'episodic_only';
  if (hasLongTerm && hfwLen <= 0) return 'durable_only';
  if (hasLongTerm && hfwLen > 0) return 'mixed';

  if (hfwLen > 0) return 'recent_topic';

  return 'state_only';
}
function decideMode(scope: RecallScope, evidenceScore: number, args: RecallGateInput): RecallMode {
  const usePastReframe = Boolean(args.outputPolicy?.usePastReframe);
  const delta = lower(args.flowDelta);

  if (scope === 'none') return 'forbidden';

  // 明示 recall は強い証拠があり、しかも topic continuity が十分な時だけ
  if (
    evidenceScore >= 0.72 &&
    (scope === 'recent_turn_only' || scope === 'recent_topic' || scope === 'mixed') &&
    (usePastReframe || delta === 'return')
  ) {
    return 'explicit';
  }

  return 'implicit';
}

function decideSafety(scope: RecallScope, evidenceScore: number, args: RecallGateInput): RecallSafety {
  const depthStage = lower(args.depthStage);
  const qCode = lower(args.qCode);

  if (scope === 'none') return 'strict';

  // S/Q3 はまず strict 寄り
  if (depthStage.startsWith('s') || qCode === 'q3') {
    if (evidenceScore >= 0.75) return 'normal';
    return 'strict';
  }

  if (evidenceScore >= 0.8) return 'open';
  if (evidenceScore >= 0.55) return 'normal';
  return 'strict';
}

export function decideRecallV1(args: RecallGateInput): RecallDecision {
  const userText = norm(args.userText);

  if (!userText) {
    const out: RecallDecision = {
      recallEligible: false,
      recallScope: 'none',
      recallReason: 'empty_user_text',
      recallMode: 'forbidden',
      recallSafety: 'strict',
      selectedSources: [],
      evidenceScore: 0,
      disallowReason: 'empty_user_text',
    };
    console.log('[IROS/MEMORY_GATE][DECISION]', out);
    return out;
  }

  const continuity = pickContinuityScore(args);
  const flow = pickFlowScore(args);
  const question = pickQuestionKindScore(args.questionType ?? null);
  const tmode = pickTModeScore(args);
  const source = pickMemorySourceScore(args);

  let evidenceScore = 0;
  evidenceScore += continuity.score;
  evidenceScore += flow.score;
  evidenceScore += question.score;
  evidenceScore += tmode.score;
  evidenceScore += source.score;

  evidenceScore = clamp01(evidenceScore);

  const selectedSources = uniq([
    continuity.score > 0 ? 'conversation' : '',
    flow.score > 0 ? 'state_flow' : '',
    ...source.selectedSources,
  ]);

  const primaryReason =
  continuity.reason ??
  tmode.reason ??
  flow.reason ??
  question.reason ??
  source.reason ??
  'weak_signal';

const scope = decideScope(args, evidenceScore, selectedSources);
const mode = decideMode(scope, evidenceScore, args);
const safety = decideSafety(scope, evidenceScore, args);

  const recallEligible = scope !== 'none' && mode !== 'forbidden';

  let disallowReason: string | null = null;
  if (!recallEligible) {
    if (evidenceScore < 0.35) disallowReason = 'low_evidence';
    else disallowReason = 'scope_or_mode_blocked';
  }

  const out: RecallDecision = {
    recallEligible,
    recallScope: scope,
    recallReason: primaryReason,
    recallMode: mode,
    recallSafety: safety,
    selectedSources,
    evidenceScore: Number(evidenceScore.toFixed(3)),
    disallowReason,
  };

  console.log('[IROS/MEMORY_GATE][DECISION]', {
    userTextHead: userText.slice(0, 80),
    depthStage: args.depthStage ?? null,
    qCode: args.qCode ?? null,
    phase: args.phase ?? null,
    flowDelta: args.flowDelta ?? null,
    returnStreak: args.returnStreak ?? null,
    stingLevel: args.stingLevel ?? null,
    questionType: args.questionType ?? null,
    questionDomain: args.questionDomain ?? null,
    tLayerHint: args.tLayerHint ?? null,
itxStep: args.itxStep ?? null,
itTriggered: Boolean(args.itTriggered),
    topicDigest: args.topicDigest ?? null,
    historyForWriterLen: args.historyForWriterLen ?? null,
    hasPastStateNoteText: Boolean(args.hasPastStateNoteText),
    longTermMemoryTypes: Array.isArray(args.longTermMemoryTypes) ? args.longTermMemoryTypes : [],
    hasEpisodicCandidate: Boolean(args.hasEpisodicCandidate),
    decision: out,
  });

  return out;
}
