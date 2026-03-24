// src/lib/iros/delta/continuityKind.ts

export type ContinuityKind =
  | 'same_line'
  | 'continuation'
  | 'branch'
  | 'return'
  | 'topic_switch'
  | 'session_break';

export type ContinuityInput = {
  currentText: string;
  previousText?: string | null;

  currentTopic?: string | null;
  previousTopic?: string | null;

  currentOpenLoop?: string | null;
  previousOpenLoop?: string | null;

  currentCore?: string | null;
  previousCore?: string | null;

  currentDepthStage?: string | null;
  previousDepthStage?: string | null;

  currentETurn?: string | null;
  previousETurn?: string | null;

  sessionBreak?: boolean | null;
  elapsedSec?: number | null;

  hasExplicitSwitchMarker?: boolean | null;
  hasReturnMarker?: boolean | null;
  hasReferenceMarker?: boolean | null;
};

export type ContinuityObserve = {
  kind: ContinuityKind;

  markers: {
    explicitSwitch: boolean;
    hasReturn: boolean;
    hasReference: boolean;
  };

  overlap: {
    topic: number;
    core: number;
    openLoop: number;
  };

  flags: {
    sessionBreak: boolean;
    longGap: boolean;
    progressed: boolean;
    sameAxis: boolean;
    branchLike: boolean;
  };

  inputs: {
    currentText: string;
    previousText: string | null;
    currentTopic: string | null;
    previousTopic: string | null;
    currentOpenLoop: string | null;
    previousOpenLoop: string | null;
    currentCore: string | null;
    previousCore: string | null;
    currentDepthStage: string | null;
    previousDepthStage: string | null;
    currentETurn: string | null;
    previousETurn: string | null;
    elapsedSec: number | null;
  };
};

const EXPLICIT_SWITCH_MARKERS = [
  '仕事の話じゃなくて',
  '別の話だけど',
  'それより',
  '話変わるけど',
  '話変わるんですが',
  '別の話',
  'ちなみに別件',
  '別件だけど',
];

const RETURN_MARKERS = [
  'やっぱり',
  '結局',
  'でもやっぱり',
  '戻るけど',
  '戻ると',
  'さっきの話に戻ると',
];

const REFERENCE_MARKERS = [
  'その話',
  'それ',
  'さっきの',
  '前の',
  'そっち',
  'この方向',
];

const LONG_GAP_SEC = 60 * 60 * 6; // 6時間。最初は保守的に固定

function normalizeText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqTokens(value: string | null | undefined): string[] {
  const s = normalizeText(value);
  if (!s) return [];
  const tokens = s
    .split(/[\s、。,.!?！？「」『』（）()・/:;\-—_]+/g)
    .map((v) => v.trim())
    .filter(Boolean);

  return Array.from(new Set(tokens));
}

function overlapScore(a: string | null | undefined, b: string | null | undefined): number {
  const aa = uniqTokens(a);
  const bb = uniqTokens(b);

  if (!aa.length || !bb.length) return 0;

  const setB = new Set(bb);
  let hit = 0;
  for (const t of aa) {
    if (setB.has(t)) hit += 1;
  }

  return hit / Math.max(aa.length, bb.length);
}

function includesAny(text: string, markers: string[]): boolean {
  if (!text) return false;
  return markers.some((m) => text.includes(normalizeText(m)));
}

export function detectSwitchMarker(text: string | null | undefined): boolean {
  return includesAny(normalizeText(text), EXPLICIT_SWITCH_MARKERS);
}

export function detectReturnMarker(text: string | null | undefined): boolean {
  return includesAny(normalizeText(text), RETURN_MARKERS);
}

export function detectReferenceMarker(text: string | null | undefined): boolean {
  return includesAny(normalizeText(text), REFERENCE_MARKERS);
}

export function calcTopicOverlap(input: Pick<ContinuityInput, 'currentTopic' | 'previousTopic'>): number {
  return overlapScore(input.currentTopic, input.previousTopic);
}

export function calcCoreOverlap(input: Pick<ContinuityInput, 'currentCore' | 'previousCore'>): number {
  return overlapScore(input.currentCore, input.previousCore);
}

export function calcOpenLoopOverlap(
  input: Pick<ContinuityInput, 'currentOpenLoop' | 'previousOpenLoop'>,
): number {
  return overlapScore(input.currentOpenLoop, input.previousOpenLoop);
}

export function isOpenLoopContinuous(
  input: Pick<ContinuityInput, 'currentOpenLoop' | 'previousOpenLoop'>,
): boolean {
  return calcOpenLoopOverlap(input) >= 0.5;
}

function stageRank(stage: string | null | undefined): number {
  const s = String(stage ?? '').trim().toUpperCase();
  if (!s) return -1;

  const m = s.match(/^([SFRCIT])(\d+)$/);
  if (!m) return -1;

  const lane = m[1];
  const num = Number(m[2]);

  const laneBase: Record<string, number> = {
    S: 0,
    F: 10,
    R: 20,
    C: 30,
    I: 40,
    T: 50,
  };

  if (!Number.isFinite(num)) return -1;
  return (laneBase[lane] ?? -1) + num;
}

function hasProgressed(
  currentDepthStage: string | null | undefined,
  previousDepthStage: string | null | undefined,
): boolean {
  const cur = stageRank(currentDepthStage);
  const prev = stageRank(previousDepthStage);
  if (cur < 0 || prev < 0) return false;
  return cur > prev;
}

function isSameAxis(topic: number, core: number, openLoop: number): boolean {
  return topic >= 0.6 || core >= 0.6 || openLoop >= 0.7;
}

function isBranchLike(topic: number, core: number, openLoop: number): boolean {
  return (topic >= 0.35 || core >= 0.35) && openLoop < 0.5;
}

export function pickContinuityKind(input: ContinuityInput): ContinuityKind {
  const currentText = normalizeText(input.currentText);
  const previousText = normalizeText(input.previousText);

  const explicitSwitch =
    input.hasExplicitSwitchMarker === true || detectSwitchMarker(currentText);

  const hasReturn =
    input.hasReturnMarker === true || detectReturnMarker(currentText);

  const hasReference =
    input.hasReferenceMarker === true ||
    detectReferenceMarker(currentText) ||
    detectReferenceMarker(previousText);

  const topic = calcTopicOverlap({
    currentTopic: input.currentTopic,
    previousTopic: input.previousTopic,
  });

  const core = calcCoreOverlap({
    currentCore: input.currentCore,
    previousCore: input.previousCore,
  });

  const openLoop = calcOpenLoopOverlap({
    currentOpenLoop: input.currentOpenLoop,
    previousOpenLoop: input.previousOpenLoop,
  });

  const longGap =
    typeof input.elapsedSec === 'number' &&
    Number.isFinite(input.elapsedSec) &&
    input.elapsedSec >= LONG_GAP_SEC;

  const sessionBreak = input.sessionBreak === true;

  const progressed = hasProgressed(
    input.currentDepthStage,
    input.previousDepthStage,
  );

  const sameAxis = isSameAxis(topic, core, openLoop);
  const branchLike = isBranchLike(topic, core, openLoop);

  // 優先順位
  if (sessionBreak || longGap) {
    return 'session_break';
  }

  if (explicitSwitch && topic < 0.35 && core < 0.35 && openLoop < 0.5) {
    return 'topic_switch';
  }

  if (hasReturn && (hasReference || topic >= 0.35 || core >= 0.35)) {
    return 'return';
  }

  if (branchLike) {
    return 'branch';
  }

  if (sameAxis && (progressed || (hasReference && openLoop >= 0.5))) {
    return 'continuation';
  }

  if (sameAxis) {
    return 'same_line';
  }

  // マーカーが無くても、重なりが低く継続性が薄ければ切替
  if (topic < 0.2 && core < 0.2 && openLoop < 0.2) {
    return 'topic_switch';
  }

  return 'continuation';
}

export function buildContinuityObserve(input: ContinuityInput): ContinuityObserve {
  const currentText = normalizeText(input.currentText);
  const previousText = normalizeText(input.previousText);

  const explicitSwitch =
    input.hasExplicitSwitchMarker === true || detectSwitchMarker(currentText);

  const hasReturn =
    input.hasReturnMarker === true || detectReturnMarker(currentText);

  const hasReference =
    input.hasReferenceMarker === true ||
    detectReferenceMarker(currentText) ||
    detectReferenceMarker(previousText);

  const topic = calcTopicOverlap({
    currentTopic: input.currentTopic,
    previousTopic: input.previousTopic,
  });

  const core = calcCoreOverlap({
    currentCore: input.currentCore,
    previousCore: input.previousCore,
  });

  const openLoop = calcOpenLoopOverlap({
    currentOpenLoop: input.currentOpenLoop,
    previousOpenLoop: input.previousOpenLoop,
  });

  const longGap =
    typeof input.elapsedSec === 'number' &&
    Number.isFinite(input.elapsedSec) &&
    input.elapsedSec >= LONG_GAP_SEC;

  const sessionBreak = input.sessionBreak === true;
  const progressed = hasProgressed(
    input.currentDepthStage,
    input.previousDepthStage,
  );
  const sameAxis = isSameAxis(topic, core, openLoop);
  const branchLike = isBranchLike(topic, core, openLoop);

  const kind = pickContinuityKind(input);

  return {
    kind,
    markers: {
      explicitSwitch,
      hasReturn,
      hasReference,
    },
    overlap: {
      topic,
      core,
      openLoop,
    },
    flags: {
      sessionBreak,
      longGap,
      progressed,
      sameAxis,
      branchLike,
    },
    inputs: {
      currentText: input.currentText,
      previousText: input.previousText ?? null,
      currentTopic: input.currentTopic ?? null,
      previousTopic: input.previousTopic ?? null,
      currentOpenLoop: input.currentOpenLoop ?? null,
      previousOpenLoop: input.previousOpenLoop ?? null,
      currentCore: input.currentCore ?? null,
      previousCore: input.previousCore ?? null,
      currentDepthStage: input.currentDepthStage ?? null,
      previousDepthStage: input.previousDepthStage ?? null,
      currentETurn: input.currentETurn ?? null,
      previousETurn: input.previousETurn ?? null,
      elapsedSec:
        typeof input.elapsedSec === 'number' && Number.isFinite(input.elapsedSec)
          ? input.elapsedSec
          : null,
    },
  };
}
