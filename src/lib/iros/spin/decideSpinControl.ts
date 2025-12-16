// 揺らぎ × 回転 × 安定化（ヒステリシス）決定器

export type StabilityBand = 'stable' | 'mixed' | 'unstable';
export type VolatilityRank = 'low' | 'mid' | 'high';
export type SpinDirection = 'forward' | 'brake'; // 相生 / 相克
export type Phase = 'Inner' | 'Outer';

export type SpinInput = {
  stabilityBand?: StabilityBand | null;
  yLevel?: number | null;
  hLevel?: number | null;
  phase?: Phase | null;

  // ★ 直前ターンの揺らぎ（MemoryState から）
  prevRank?: VolatilityRank | null;
};

export type SpinDecision = {
  rank: VolatilityRank;
  direction: SpinDirection;
  shouldConfirmAnchor: boolean;
  promptStyle: 'one-step' | 'two-choice' | 'safety-brake';
  debug: {
    baseRank: VolatilityRank;
    phase: Phase;
    hysteresisApplied: boolean;
  };
};

function normalizePhase(p?: Phase | null): Phase {
  return p === 'Outer' ? 'Outer' : 'Inner';
}

function calcBaseRank(input: SpinInput): VolatilityRank {
  // A) stabilityBand 優先
  if (input.stabilityBand) {
    if (input.stabilityBand === 'unstable') return 'high';
    if (input.stabilityBand === 'mixed') return 'mid';
    return 'low';
  }

  // B) y/h 数値判定
  const y = input.yLevel ?? null;
  const h = input.hLevel ?? null;
  if (typeof y === 'number' && typeof h === 'number') {
    const diff = Math.abs(h - y);
    const avg = (h + y) / 2;

    if (diff >= 1.5 || avg >= 2.5) return 'high';
    if (diff >= 0.8 || avg >= 1.8) return 'mid';
    return 'low';
  }

  // C) フォールバック
  return 'mid';
}

function applyHysteresis(
  base: VolatilityRank,
  prev?: VolatilityRank | null
): { rank: VolatilityRank; applied: boolean } {
  if (!prev) return { rank: base, applied: false };

  // high → 次ターンでいきなり low に落とさない
  if (prev === 'high' && base === 'low') {
    return { rank: 'mid', applied: true };
  }

  // low は 2 連続しないと確定させない
  if (base === 'low' && prev !== 'low') {
    return { rank: 'mid', applied: true };
  }

  return { rank: base, applied: false };
}

export function decideSpinControl(input: SpinInput): SpinDecision {
  const phase = normalizePhase(input.phase);
  const baseRank = calcBaseRank(input);
  const { rank, applied } = applyHysteresis(baseRank, input.prevRank);

  const direction: SpinDirection =
    rank === 'high' ? 'brake' : 'forward';

  return {
    rank,
    direction,
    shouldConfirmAnchor: rank === 'high',
    promptStyle:
      rank === 'low'
        ? 'one-step'
        : rank === 'mid'
        ? 'two-choice'
        : 'safety-brake',
    debug: {
      baseRank,
      phase,
      hysteresisApplied: applied,
    },
  };
}
