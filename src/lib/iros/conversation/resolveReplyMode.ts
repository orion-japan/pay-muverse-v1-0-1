// src/lib/iros/conversation/resolveReplyMode.ts

export type ReplyMode = 'clarify' | 'compare' | 'decide' | 'commit';

export type ReplyLaneKey = 'IDEA_BAND' | 'T_CONCRETIZE' | null;

export type ReplyShiftKind =
  | 'clarify_shift'
  | 'stabilize_shift'
  | 'distance_shift'
  | 'repair_shift'
  | 'narrow_shift'
  | 'decide_shift';

export type ReplyGoalKind = 'clarify' | 'expand' | 'decide';
export type ReplyTargetKind = 'clarify' | 'expand' | 'decide';

export type ReplyModeDecision = {
  replyMode: ReplyMode;
  reason: string;
  laneKey: ReplyLaneKey;
  shiftKind: ReplyShiftKind;
  goalKind: ReplyGoalKind;
  targetKind: ReplyTargetKind;
  allowHints: {
    concretize: boolean;
    commitHint: boolean;
  };
};

export type ResolveReplyModeInput = {
  userText?: string | null;
  lastAssistantText?: string | null;

  resolvedAskType?: string | null;
  shiftKind?: string | null;
  stampedShiftKind?: string | null;
  goalKind?: string | null;
  replyGoal?: string | null;
  laneKey?: string | null;
  targetKind?: string | null;

  topicDigest?: unknown;
  topicDigestV2?: unknown;
  conversationLine?: unknown;
};

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

function stringifyLoose(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildReason(label: string, detail?: string): string {
  return detail ? `${label}: ${detail}` : label;
}

const DECIDE_PATTERNS: RegExp[] = [
  /どっちがいい/,
  /どちらがいい/,
  /どれがいい/,
  /どうすればいい/,
  /どうしたらいい/,
  /どう決め/,
  /決めきれない/,
  /決められない/,
  /決めたい/,
  /決断/,
  /方針を決め/,
  /選んだほうがいい/,
  /\bshould i\b/,
  /\bwhich\b.+\bbetter\b/,
  /\bdecide\b/,
  /\bdecision\b/,
];

const COMPARE_PATTERNS: RegExp[] = [
  /比較/,
  /比べ/,
  /違い/,
  /整理して/,
  /選択肢/,
  /候補/,
  /メリット/,
  /デメリット/,
  /良い点/,
  /悪い点/,
  /一覧/,
  /パターン/,
  /\bcompare\b/,
  /\bcomparison\b/,
  /\bpros?\b/,
  /\bcons?\b/,
  /\boptions?\b/,
];

const CLARIFY_PATTERNS: RegExp[] = [
  /どういう意味/,
  /どういうこと/,
  /何が言いたい/,
  /何を意味/,
  /整理したい/,
  /はっきりさせたい/,
  /確認したい/,
  /定義/,
  /真意/,
  /\bclarify\b/,
  /\bmeaning\b/,
  /\bdefine\b/,
  /\bdefinition\b/,
];

const COMMIT_PATTERNS: RegExp[] = [
  /この方針でいく/,
  /これでいく/,
  /進める/,
  /やることは決まった/,
  /次の一手/,
  /まず何をする/,
  /最初の一歩/,
  /行動に落と/,
  /具体化/,
  /実行/,
  /コミット/,
  /\bnext step\b/,
  /\bcommit\b/,
  /\bexecute\b/,
  /\baction\b/,
];

function decideFromCurrentTurn(input: ResolveReplyModeInput): ReplyModeDecision | null {
  const userText = normalizeText(input.userText);
  const resolvedAskType = normalizeText(input.resolvedAskType);
  const replyGoal = normalizeText(input.replyGoal);
  const joined = [userText, resolvedAskType, replyGoal].filter(Boolean).join(' | ');

  if (!joined) return null;

  if (
    hasAny(joined, COMPARE_PATTERNS) &&
    !hasAny(joined, DECIDE_PATTERNS) &&
    !hasAny(joined, COMMIT_PATTERNS)
  ) {
    return {
      replyMode: 'compare',
      reason: buildReason('current_turn_compare', joined),
      laneKey: 'IDEA_BAND',
      shiftKind: 'narrow_shift',
      goalKind: 'expand',
      targetKind: 'expand',
      allowHints: {
        concretize: false,
        commitHint: false,
      },
    };
  }

  if (hasAny(joined, DECIDE_PATTERNS)) {
    return {
      replyMode: 'decide',
      reason: buildReason('current_turn_decide', joined),
      laneKey: 'T_CONCRETIZE',
      shiftKind: 'decide_shift',
      goalKind: 'decide',
      targetKind: 'decide',
      allowHints: {
        concretize: true,
        commitHint: true,
      },
    };
  }

  if (hasAny(joined, CLARIFY_PATTERNS)) {
    return {
      replyMode: 'clarify',
      reason: buildReason('current_turn_clarify', joined),
      laneKey: null,
      shiftKind: 'clarify_shift',
      goalKind: 'clarify',
      targetKind: 'clarify',
      allowHints: {
        concretize: false,
        commitHint: false,
      },
    };
  }

  if (hasAny(joined, COMMIT_PATTERNS)) {
    return {
      replyMode: 'commit',
      reason: buildReason('current_turn_commit', joined),
      laneKey: 'T_CONCRETIZE',
      shiftKind: 'decide_shift',
      goalKind: 'decide',
      targetKind: 'decide',
      allowHints: {
        concretize: true,
        commitHint: true,
      },
    };
  }

  return null;
}

function decideFromFallback(input: ResolveReplyModeInput): ReplyModeDecision {
  const shiftKind = normalizeText(input.shiftKind || input.stampedShiftKind);
  const goalKind = normalizeText(input.goalKind);
  const laneKey = normalizeText(input.laneKey);
  const targetKind = normalizeText(input.targetKind);

  const topicDigest = normalizeText(stringifyLoose(input.topicDigest));
  const topicDigestV2 = normalizeText(stringifyLoose(input.topicDigestV2));
  const conversationLine = normalizeText(stringifyLoose(input.conversationLine));

  const fallbackJoined = [
    shiftKind,
    goalKind,
    laneKey,
    targetKind,
    topicDigest,
    topicDigestV2,
    conversationLine,
  ]
    .filter(Boolean)
    .join(' | ');

  if (
    shiftKind.includes('decide') ||
    goalKind === 'decide' ||
    targetKind === 'decide' ||
    laneKey.includes('t_concretize')
  ) {
    return {
      replyMode: 'decide',
      reason: buildReason('fallback_decide', fallbackJoined),
      laneKey: 'T_CONCRETIZE',
      shiftKind: 'decide_shift',
      goalKind: 'decide',
      targetKind: 'decide',
      allowHints: {
        concretize: true,
        commitHint: true,
      },
    };
  }

  if (shiftKind.includes('clarify') || goalKind === 'clarify' || targetKind === 'clarify') {
    return {
      replyMode: 'clarify',
      reason: buildReason('fallback_clarify', fallbackJoined),
      laneKey: null,
      shiftKind: 'clarify_shift',
      goalKind: 'clarify',
      targetKind: 'clarify',
      allowHints: {
        concretize: false,
        commitHint: false,
      },
    };
  }

  if (laneKey.includes('idea_band')) {
    return {
      replyMode: 'compare',
      reason: buildReason('fallback_compare', fallbackJoined),
      laneKey: 'IDEA_BAND',
      shiftKind: 'narrow_shift',
      goalKind: 'expand',
      targetKind: 'expand',
      allowHints: {
        concretize: false,
        commitHint: false,
      },
    };
  }

  if (
    hasAny(fallbackJoined, COMMIT_PATTERNS) &&
    !hasAny(fallbackJoined, CLARIFY_PATTERNS)
  ) {
    return {
      replyMode: 'commit',
      reason: buildReason('fallback_commit', fallbackJoined),
      laneKey: 'T_CONCRETIZE',
      shiftKind: 'decide_shift',
      goalKind: 'decide',
      targetKind: 'decide',
      allowHints: {
        concretize: true,
        commitHint: true,
      },
    };
  }

  return {
    replyMode: 'clarify',
    reason: buildReason('default_clarify', fallbackJoined || 'no_strong_signal'),
    laneKey: null,
    shiftKind: 'clarify_shift',
    goalKind: 'clarify',
    targetKind: 'clarify',
    allowHints: {
      concretize: false,
      commitHint: false,
    },
  };
}

/**
 * 司令塔:
 * そのターンの返答責務を先に1つ確定する。
 *
 * 判定順:
 * 1. compare 明示要求
 * 2. decide 明示要求
 * 3. clarify 要求
 * 4. commit 要求
 * 5. 既存メタ fallback
 *
 * 重要:
 * stale な stampedShiftKind より、現在ターンの要求を優先する。
 */
export function resolveReplyMode(input: ResolveReplyModeInput): ReplyModeDecision {
  const currentTurnDecision = decideFromCurrentTurn(input);
  if (currentTurnDecision) return currentTurnDecision;
  return decideFromFallback(input);
}
