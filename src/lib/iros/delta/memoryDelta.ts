export type MemoryDelta = {
  previousCore: string | null;
  currentAsk: string;
  changedPoint: string | null;
  stablePoint: string | null;
  nextFocus: string | null;
};

export type BuildMemoryDeltaArgs = {
  previousCore?: unknown;
  currentAsk?: unknown;
  nextFocus?: unknown;
  stableHint?: unknown;
};

const cleanMemoryDeltaText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const compactMemoryDeltaText = (value: unknown): string => {
  return cleanMemoryDeltaText(value)
    .replace(/\s+/g, '')
    .replace(/[「」『』（）()［］\[\]{}｛｝、。,.!！?？:：・\-—―_]/g, '')
    .trim();
};

const clampMemoryDeltaLine = (value: unknown, max = 120): string => {
  const text = cleanMemoryDeltaText(value).replace(/\n+/g, ' ');
  return text.length > max ? text.slice(0, max) : text;
};

export const buildMemoryDelta = (args: BuildMemoryDeltaArgs): MemoryDelta => {
  const previousCore = clampMemoryDeltaLine(args.previousCore, 120) || null;
  const currentAsk = clampMemoryDeltaLine(args.currentAsk, 120);
  const nextFocus = clampMemoryDeltaLine(args.nextFocus, 120) || null;
  const stableHint = clampMemoryDeltaLine(args.stableHint, 120) || null;

  const previousKey = compactMemoryDeltaText(previousCore);
  const currentKey = compactMemoryDeltaText(currentAsk);

  const hasPrevious = Boolean(previousCore && previousKey);
  const hasCurrent = Boolean(currentAsk && currentKey);

  const isSameCore =
    hasPrevious &&
    hasCurrent &&
    (previousKey === currentKey ||
      previousKey.includes(currentKey) ||
      currentKey.includes(previousKey));

  const changedPoint =
    hasPrevious && hasCurrent && !isSameCore
      ? currentAsk
      : null;

  const stablePoint =
    isSameCore
      ? previousCore
      : stableHint;

  return {
    previousCore,
    currentAsk,
    changedPoint,
    stablePoint,
    nextFocus,
  };
};

export const formatMemoryDeltaSeed = (delta: MemoryDelta | null): string | null => {
  if (!delta) return null;

  const lines = [
    'MEMORY_DELTA (DO NOT OUTPUT):',
    delta.previousCore ? `previousCore=${delta.previousCore}` : '',
    delta.currentAsk ? `currentAsk=${delta.currentAsk}` : '',
    delta.changedPoint ? `changedPoint=${delta.changedPoint}` : '',
    delta.stablePoint ? `stablePoint=${delta.stablePoint}` : '',
    delta.nextFocus ? `nextFocus=${delta.nextFocus}` : '',
    'source=iros_memory_delta',
  ].filter(Boolean);

  return lines.length > 2 ? lines.join('\n') : null;
};