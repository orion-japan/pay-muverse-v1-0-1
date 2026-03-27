export type AwakenLevel = 'none' | 'pre' | 'rise' | 'stable';

export type ResolveAwakenStateInput = {
  flowDelta?: string | null;
  returnStreak?: number | null;

  observedStage?: string | null;
  depthStage?: string | null;

  goalKindBefore?: string | null;
  targetKind?: string | null;

  flowFrom?: string | null;
  flowTo?: string | null;

  writerOutput?: string | null;
  seedMeaning?: string | null;
  seedDelta?: string | null;
  focusText?: string | null;
};

export type ResolveAwakenStateResult = {
  signal: boolean;
  score: number;
  level: AwakenLevel;

  // 覚醒中フラグ
  // - rise / stable のとき true
  // - pre は兆候のみなので false
  inProgress: boolean;

  reasons: string[];
  at: string | null;

  detail: {
    flowRise: boolean;
    resonanceBand: boolean;
    commandAligned: boolean;
    writerAligned: boolean;
    collapseHint: boolean;
  };
};

function norm(v: unknown): string {
  return String(v ?? '').trim();
}

function normLower(v: unknown): string {
  return norm(v).toLowerCase();
}

function stageRank(stageRaw: string | null | undefined): number {
  const s = norm(stageRaw).toUpperCase();
  if (!s) return 0;

  const m = s.match(/^([SRICT])([1-3])$/);
  if (!m) return 0;

  const band = m[1];
  const level = Number(m[2]);

  const bandBase: Record<string, number> = {
    S: 0,
    R: 3,
    C: 6,
    I: 9,
    T: 12,
  };

  return (bandBase[band] ?? 0) + level;
}

function isResonanceBand(stageRaw: string | null | undefined): boolean {
  const s = norm(stageRaw).toUpperCase();
  if (!s) return false;

  // 仕様:
  // - S2以上
  // - R/C/I/T 帯
  if (s === 'S2' || s === 'S3') return true;
  if (/^[RCIT][1-3]$/.test(s)) return true;

  return false;
}

function isResonateLike(kindRaw: string | null | undefined): boolean {
  const s = normLower(kindRaw);
  return s === 'resonate' || s === 'expand' || s === 'forward';
}

function detectFlowRise(input: ResolveAwakenStateInput): boolean {
  const from = norm(input.flowFrom);
  const to = norm(input.flowTo);

  if (from && to) {
    const fromStage = extractStageFromFlowCoord(from);
    const toStage = extractStageFromFlowCoord(to);

    const fromRank = stageRank(fromStage);
    const toRank = stageRank(toStage);

    if (fromRank > 0 && toRank > 0 && toRank > fromRank) {
      return true;
    }
  }

  const flowDelta = normLower(input.flowDelta);
  if (
    flowDelta === 'rise' ||
    flowDelta === 'up' ||
    flowDelta === 'advance' ||
    flowDelta === 'expand'
  ) {
    return true;
  }

  return false;
}

function extractStageFromFlowCoord(v: string): string {
  // 例:
  // e1-C2-pos
  // e2-S1-pos
  const m = v.match(/-(S[1-3]|R[1-3]|C[1-3]|I[1-3]|T[1-3])-/i);
  return m?.[1]?.toUpperCase() ?? '';
}

function includesAny(base: string, parts: string[]): boolean {
  if (!base) return false;
  return parts.some((p) => p && base.includes(p));
}

function normalizeTextForMatch(v: string | null | undefined): string {
  return norm(v).replace(/\s+/g, ' ').trim().toLowerCase();
}

function detectWriterAligned(input: ResolveAwakenStateInput): boolean {
  const out = normalizeTextForMatch(input.writerOutput);
  const meaning = normalizeTextForMatch(input.seedMeaning);
  const delta = normalizeTextForMatch(input.seedDelta);
  const focus = normalizeTextForMatch(input.focusText);

  if (!out) return false;

  let score = 0;

  if (meaning) {
    const meaningTokens = compactTokens(meaning);
    if (meaningTokens.length > 0 && meaningTokens.some((t) => out.includes(t))) {
      score += 1;
    }
  }

  if (delta) {
    const deltaTokens = compactTokens(delta);
    if (deltaTokens.length > 0 && deltaTokens.some((t) => out.includes(t))) {
      score += 1;
    }
  }

  if (focus) {
    const focusTokens = compactTokens(focus);
    if (focusTokens.length > 0 && focusTokens.some((t) => out.includes(t))) {
      score += 1;
    }
  }

  const genericPenalty = includesAny(out, [
    '一般論',
    '場合があります',
    '人それぞれ',
    '一概には言えません',
  ])
    ? 1
    : 0;

  const questionPenalty = out.includes('？') || out.includes('?') ? 1 : 0;

  return score >= 1 && genericPenalty === 0 && questionPenalty === 0;
}

function compactTokens(v: string): string[] {
  return v
    .split(/[、。,\-\/\s]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .slice(0, 12);
}

function detectCollapseHint(
  input: ResolveAwakenStateInput,
  detail: {
    flowRise: boolean;
    resonanceBand: boolean;
    commandAligned: boolean;
    writerAligned: boolean;
  },
): boolean {
  const returnStreak = Number(input.returnStreak ?? 0);
  const goalKindBefore = normLower(input.goalKindBefore);
  const observedStage = norm(input.observedStage).toUpperCase();
  const depthStage = norm(input.depthStage).toUpperCase();

  if (returnStreak >= 1 && !detail.writerAligned) {
    return true;
  }

  if (
    detail.resonanceBand &&
    detail.commandAligned &&
    goalKindBefore === 'stabilize'
  ) {
    return true;
  }

  if (
    observedStage &&
    depthStage &&
    stageRank(observedStage) > 0 &&
    stageRank(depthStage) > 0 &&
    stageRank(depthStage) + 2 <= stageRank(observedStage)
  ) {
    return true;
  }

  return false;
}

function levelFromScore(score: number): AwakenLevel {
  if (score >= 3) return 'stable';
  if (score === 2) return 'rise';
  if (score === 1) return 'pre';
  return 'none';
}

function inProgressFromLevel(level: AwakenLevel): boolean {
  return level === 'rise' || level === 'stable';
}

export function resolveAwakenState(
  input: ResolveAwakenStateInput,
): ResolveAwakenStateResult {
  const reasons: string[] = [];

  const flowRise = detectFlowRise(input);
  if (flowRise) reasons.push('flow_rise');

  const resonanceBand =
    isResonanceBand(input.observedStage) ||
    isResonanceBand(input.depthStage);
  if (resonanceBand) reasons.push('resonance_band');

  const commandAligned =
    isResonateLike(input.targetKind) ||
    isResonateLike(input.goalKindBefore);
  if (commandAligned) reasons.push('command_aligned');

  const writerAligned = detectWriterAligned(input);
  if (writerAligned) reasons.push('writer_aligned');

  let score = 0;
  if (flowRise) score += 1;
  if (resonanceBand) score += 1;
  if (commandAligned) score += 1;
  if (writerAligned) score += 1;

  const collapseHint = detectCollapseHint(input, {
    flowRise,
    resonanceBand,
    commandAligned,
    writerAligned,
  });

  if (collapseHint) {
    reasons.push('collapse_hint');
  }

  const level = levelFromScore(score);
  const signal = score >= 1;
  const inProgress = inProgressFromLevel(level);

  return {
    signal,
    score,
    level,
    inProgress,
    reasons,
    at: new Date().toISOString(),
    detail: {
      flowRise,
      resonanceBand,
      commandAligned,
      writerAligned,
      collapseHint,
    },
  };
}
