// src/lib/iros/delta/transitionMeaning.ts

export type TransitionMeaning =
  | 'forward'
  | 'backward'
  | 'stagnation'
  | 'jump'
  | 'collapse'
  | 'stabilize'
  | 'pre_hit';

export type TransitionInput = {
  prevFlow: string | null;
  nowFlow: string | null;
  delta: string | null;

  e_turn_prev: string | null;
  e_turn_now: string | null;

  layer_prev: string | null;
  layer_now: string | null;

  polarity_prev?: string | null;
  polarity_now?: string | null;

  intentShift?: boolean | null;
  returnStreak?: number | null;
  stingLevel?: string | null;
};

function norm(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length ? s : null;
}

function layerRank(layer: string | null): number {
  if (!layer) return -1;
  const m = /^([A-Z])(\d+)$/i.exec(layer.trim());
  if (!m) return -1;

  const band = m[1].toUpperCase();
  const depth = Number(m[2]);

  const bandBase: Record<string, number> = {
    S: 0,
    R: 10,
    C: 20,
    I: 30,
    T: 40,
  };

  if (!(band in bandBase) || !Number.isFinite(depth)) return -1;
  return bandBase[band] + depth;
}

function eTurnRank(v: string | null): number {
  if (!v) return -1;
  const m = /^e(\d+)$/i.exec(v.trim());
  if (!m) return -1;
  return Number(m[1]);
}

function isHighSting(v: string | null): boolean {
  const s = String(v ?? '').trim().toUpperCase();
  return s === 'HIGH' || s === 'SEVERE';
}

function isSame(a: string | null, b: string | null): boolean {
  return (a ?? null) === (b ?? null);
}

/**
 * PDF準拠:
 * 優先順位
 * 1. collapse
 * 2. pre_hit
 * 3. jump
 * 4. forward
 * 5. backward
 * 6. stabilize
 * 7. stagnation
 */
export function pickTransitionMeaning(input: TransitionInput): TransitionMeaning {
  const prevFlow = norm(input.prevFlow);
  const nowFlow = norm(input.nowFlow);
  const delta = norm(input.delta);

  const ePrev = norm(input.e_turn_prev);
  const eNow = norm(input.e_turn_now);

  const layerPrev = norm(input.layer_prev);
  const layerNow = norm(input.layer_now);

  const polarityPrev = norm(input.polarity_prev);
  const polarityNow = norm(input.polarity_now);

  const returnStreak = Number.isFinite(input.returnStreak as number)
    ? Number(input.returnStreak)
    : 0;

  const intentShift = input.intentShift === true;
  const highSting = isHighSting(input.stingLevel ?? null);

  const layerPrevRank = layerRank(layerPrev);
  const layerNowRank = layerRank(layerNow);
  const ePrevRank = eTurnRank(ePrev);
  const eNowRank = eTurnRank(eNow);

  const layerJumpUp =
    layerPrevRank >= 0 && layerNowRank >= 0 && layerNowRank - layerPrevRank >= 10;

  const movedForwardInLayer =
    layerPrevRank >= 0 && layerNowRank >= 0 && layerNowRank > layerPrevRank;

  const movedBackwardInLayer =
    layerPrevRank >= 0 && layerNowRank >= 0 && layerNowRank < layerPrevRank;

  const sameLayer = layerPrevRank >= 0 && layerNowRank >= 0 && layerPrevRank === layerNowRank;
  const sameFlow = isSame(prevFlow, nowFlow);
  const sameETurn = isSame(ePrev, eNow);
  const samePolarity = isSame(polarityPrev, polarityNow);

  // 1. collapse
  if (
    delta === 'collapse' ||
    delta === 'break' ||
    delta === 'drop' ||
    (highSting && returnStreak >= 2 && movedBackwardInLayer)
  ) {
    return 'collapse';
  }

  // 2. pre_hit
  if (
    intentShift &&
    !highSting &&
    (returnStreak >= 1 || delta === 'near_core' || delta === 'pre_hit')
  ) {
    return 'pre_hit';
  }

  // 3. jump
  if (
    delta === 'jump' ||
    layerJumpUp ||
    (movedForwardInLayer && ePrevRank >= 0 && eNowRank >= 0 && eNowRank - ePrevRank >= 2)
  ) {
    return 'jump';
  }

  // 4. forward
  if (
    delta === 'forward' ||
    delta === 'advance' ||
    movedForwardInLayer ||
    (sameLayer && ePrevRank >= 0 && eNowRank >= 0 && eNowRank > ePrevRank)
  ) {
    return 'forward';
  }

  // 5. backward
  if (
    delta === 'backward' ||
    delta === 'return' ||
    movedBackwardInLayer ||
    returnStreak >= 1
  ) {
    return 'backward';
  }

  // 6. stabilize
  if (
    delta === 'stabilize' ||
    delta === 'hold' ||
    (sameLayer && sameFlow && sameETurn && !highSting)
  ) {
    return 'stabilize';
  }

  // 7. stagnation
  if (
    delta === 'same' ||
    delta === 'stagnation' ||
    (sameLayer && sameFlow && sameETurn && samePolarity)
  ) {
    return 'stagnation';
  }

  // 最後の保険: 完全同一なら stagnation、そうでなければ stabilize
  return sameLayer && sameFlow && sameETurn ? 'stagnation' : 'stabilize';
}

export function buildTransitionLog(input: TransitionInput) {
  const picked = pickTransitionMeaning(input);

  return {
    prevFlow: input.prevFlow ?? null,
    nowFlow: input.nowFlow ?? null,
    delta: input.delta ?? null,
    e_turn_prev: input.e_turn_prev ?? null,
    e_turn_now: input.e_turn_now ?? null,
    layer_prev: input.layer_prev ?? null,
    layer_now: input.layer_now ?? null,
    polarity_prev: input.polarity_prev ?? null,
    polarity_now: input.polarity_now ?? null,
    intentShift: input.intentShift ?? null,
    returnStreak: input.returnStreak ?? null,
    stingLevel: input.stingLevel ?? null,
    picked,
  };
}
