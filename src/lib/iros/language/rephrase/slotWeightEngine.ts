export type SlotName = 'OBS' | 'SHIFT' | 'NEXT' | 'SAFE';

export type SlotWeightInput = {
  depthStage?: string | null;
  questionType?: 'meaning' | 'structure' | 'intent' | 'fact' | 'truth' | null;
  goalKind?:
    | 'stabilize'
    | 'resonate'
    | 'decide'
    | 'uncover'
    | 'clarify'
    | 'replace'
    | 'remake'
    | null
    | string;
  deltaType?:
    | 'same'
    | 'stage_shift'
    | 'energy_shift'
    | 'stage_energy'
    | 'polarity_flip'
    | null
    | string;
  returnStreak?: number | null;
  continuityKind?: 'same_line' | 'continuation' | 'topic_switch' | 'jump' | null | string;
};

export type SlotWeights = Record<SlotName, number>;

export type SlotDecision = {
  weights: SlotWeights;
  order: SlotName[];
  emphasis: Record<SlotName, 1 | 2 | 3>;
};

function normalizeGoalKind(raw: unknown): string {
  const goal = String(raw ?? '').trim().toLowerCase();

  if (
    goal === 'replace' ||
    goal === 'reframe' ||
    goal === 'rephrase' ||
    goal === 'rewrite'
  ) {
    return 'replace';
  }

  if (
    goal === 'remake' ||
    goal === 'repair' ||
    goal === 'rebuild' ||
    goal === 'restore' ||
    goal === 'integration'
  ) {
    return 'remake';
  }

  return goal;
}

function clampWeight(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1.5, Number(n.toFixed(4))));
}

function bringToFront(order: SlotName[], preferred: SlotName[]): SlotName[] {
  const picked: SlotName[] = [];
  for (const key of preferred) {
    if (order.includes(key) && !picked.includes(key)) picked.push(key);
  }
  for (const key of order) {
    if (!picked.includes(key)) picked.push(key);
  }
  return picked;
}

export function computeSlotDecision(input: SlotWeightInput): SlotDecision {
  const depthBand = String(input?.depthStage ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 1) as 'S' | 'R' | 'C' | 'I' | 'T' | '';

  const baseWeightsByDepth: Record<'S' | 'R' | 'C' | 'I' | 'T', SlotWeights> = {
    S: { OBS: 0.95, SHIFT: 0.50, NEXT: 0.18, SAFE: 0.78 },
    R: { OBS: 0.72, SHIFT: 0.78, NEXT: 0.40, SAFE: 0.72 },
    C: { OBS: 0.58, SHIFT: 0.82, NEXT: 0.78, SAFE: 0.55 },
    I: { OBS: 0.38, SHIFT: 0.88, NEXT: 0.82, SAFE: 0.82 },
    T: { OBS: 0.28, SHIFT: 0.74, NEXT: 0.72, SAFE: 0.98 },
  };

  const weights: SlotWeights = {
    ...(baseWeightsByDepth[depthBand || 'C'] ?? baseWeightsByDepth.C),
  };

  const goalKind = normalizeGoalKind(input?.goalKind);
  const deltaType = String(input?.deltaType ?? '').trim().toLowerCase();
  const continuityKind = String(input?.continuityKind ?? '').trim().toLowerCase();
  const questionType = String(input?.questionType ?? '').trim().toLowerCase();
  const returnStreak =
    typeof input?.returnStreak === 'number' && Number.isFinite(input.returnStreak)
      ? input.returnStreak
      : 0;

  const supportiveMode =
    goalKind === 'stabilize' ||
    goalKind === 'clarify' ||
    goalKind === 'resonate' ||
    goalKind === 'replace' ||
    goalKind === 'remake';

  const remakeLike = goalKind === 'replace' || goalKind === 'remake';
  const truthLike = questionType === 'truth' || questionType === 'fact';

  switch (goalKind) {
    case 'stabilize':
      weights.OBS += 0.22;
      weights.SAFE += 0.30;
      weights.NEXT -= 0.25;
      break;

    case 'resonate':
      weights.OBS += 0.08;
      weights.SHIFT += 0.18;
      weights.SAFE += 0.10;
      weights.NEXT -= 0.02;
      break;

    case 'decide':
      weights.NEXT += 0.28;
      weights.SHIFT += 0.08;
      weights.SAFE += 0.05;
      weights.OBS -= 0.08;
      break;

    case 'uncover':
      weights.OBS += 0.12;
      weights.SHIFT += 0.25;
      weights.SAFE += 0.05;
      break;

    case 'clarify':
      weights.OBS += 0.28;
      weights.SHIFT += 0.14;
      weights.SAFE += 0.06;
      weights.NEXT -= 0.08;
      break;

    case 'replace':
      weights.OBS += 0.32;
      weights.SHIFT += 0.30;
      weights.SAFE += 0.24;
      weights.NEXT -= 0.24;
      break;

    case 'remake':
      weights.OBS += 0.24;
      weights.SHIFT += 0.36;
      weights.SAFE += 0.32;
      weights.NEXT -= 0.30;
      break;
  }

  switch (deltaType) {
    case 'same':
      weights.OBS += 0.10;
      weights.SAFE += 0.14;
      weights.NEXT -= 0.05;
      break;

    case 'energy_shift':
    case 'stage_energy':
      weights.SHIFT += 0.20;
      if (remakeLike) {
        weights.SAFE += 0.08;
        weights.NEXT += 0.02;
      } else {
        weights.NEXT += 0.16;
      }
      break;

    case 'polarity_flip':
      weights.OBS += 0.05;
      weights.SHIFT += 0.18;
      weights.SAFE += 0.08;
      break;

    case 'stage_shift':
      weights.SHIFT += 0.16;
      weights.NEXT += 0.10;
      break;
  }

  if (returnStreak >= 2) {
    weights.OBS += 0.12;
    weights.SHIFT += 0.05;
    weights.SAFE += 0.22;
    weights.NEXT -= 0.14;
  }

  switch (continuityKind) {
    case 'same_line':
    case 'continuation':
      weights.SHIFT += 0.10;
      if (supportiveMode) {
        weights.SAFE += 0.06;
      } else {
        weights.NEXT += 0.05;
      }
      break;

    case 'topic_switch':
    case 'jump':
      weights.OBS += 0.20;
      weights.SAFE += 0.10;
      weights.NEXT -= 0.05;
      break;
  }

  switch (questionType) {
    case 'structure':
      weights.OBS += 0.22;
      weights.SHIFT += 0.22;
      weights.SAFE += 0.04;
      break;

    case 'meaning':
      weights.SHIFT += 0.28;
      weights.SAFE += 0.16;
      weights.NEXT -= 0.05;
      break;

    case 'intent':
      weights.NEXT += 0.22;
      weights.SAFE += 0.18;
      weights.OBS -= 0.04;
      break;

    case 'truth':
    case 'fact':
      weights.OBS += 0.32;
      weights.SHIFT += 0.10;
      weights.SAFE += 0.06;
      weights.NEXT -= 0.25;
      break;
  }

  (Object.keys(weights) as SlotName[]).forEach((k) => {
    weights[k] = clampWeight(weights[k]);
  });

  let order = (Object.entries(weights) as Array<[SlotName, number]>)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);

    if (truthLike) {
      order = bringToFront(order, ['OBS', 'SHIFT', 'NEXT', 'SAFE']);
    } else if (
      goalKind === 'uncover' ||
      remakeLike ||
      supportiveMode ||
      questionType === 'meaning' ||
      questionType === 'structure'
    ) {
      order = bringToFront(order, ['OBS', 'SHIFT']);
    }

  order = [...order.filter((k) => k !== 'SAFE'), 'SAFE'] as SlotName[];

  const obsIndex = order.indexOf('OBS');
  if (obsIndex > 1) {
    order.splice(obsIndex, 1);
    order.splice(1, 0, 'OBS');
  }

  const emphasis: Record<SlotName, 1 | 2 | 3> = {
    OBS:
      weights.OBS >= (supportiveMode || truthLike ? 1.15 : 1.2)
        ? 3
        : weights.OBS >= (supportiveMode || truthLike ? 0.8 : 0.85)
          ? 2
          : 1,
    SHIFT:
      weights.SHIFT >= (supportiveMode || remakeLike ? 1.1 : 1.15)
        ? 3
        : weights.SHIFT >= (supportiveMode ? 0.8 : 0.85)
          ? 2
          : 1,
          NEXT:
          questionType === 'structure'
            ? weights.NEXT >= 1.1
              ? 3
              : weights.NEXT >= 0.25
                ? 2
                : 1
            : weights.NEXT >= 1.1
              ? 3
              : weights.NEXT >= 0.95
                ? 2
                : 1,
    SAFE:
      weights.SAFE >= (supportiveMode || remakeLike ? 1.1 : 1.15)
        ? 3
        : weights.SAFE >= (supportiveMode || remakeLike ? 0.8 : 0.85)
          ? 2
          : 1,
  };
  if (remakeLike) {
    emphasis.NEXT = 1;
  }

  if (questionType === 'structure' && emphasis.OBS === 3 && emphasis.NEXT === 1) {
    emphasis.OBS = 2;
    emphasis.NEXT = 2;
  }

  if (questionType === 'structure' && supportiveMode && emphasis.SHIFT === 1 && emphasis.SAFE === 3) {
    emphasis.SHIFT = 2;
    emphasis.SAFE = 2;
  }

  return { weights, order, emphasis };
}
