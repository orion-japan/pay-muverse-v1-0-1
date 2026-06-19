export type IntuitionInput = {
  previousCore?: unknown;
  currentAsk?: unknown;
  changedPoint?: unknown;
  stablePoint?: unknown;
  nextFocus?: unknown;

  depthStage?: unknown;
  qCode?: unknown;
  phase?: unknown;
  eTurn?: unknown;
  flowDelta?: unknown;
  returnStreak?: unknown;

  topicDigest?: unknown;
  conversationLine?: unknown;
};

export type IntuitionCandidate = {
  source: 'iros_intuition_candidate';
  confidence: number;
  coreReading: string | null;
  hiddenShift: string | null;
  relationHint: string | null;
  writerHint: string | null;
  avoid: string[];
};

const cleanIntuitionText = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t　]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const clampIntuitionLine = (value: unknown, max = 120): string => {
  const text = cleanIntuitionText(value).replace(/\n+/g, ' ');
  return text.length > max ? text.slice(0, max) : text;
};

const toNumberOrNull = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const clampConfidence = (value: number): number => {
  if (!Number.isFinite(value)) return 0.3;
  return Math.max(0.1, Math.min(0.85, Math.round(value * 100) / 100));
};

export const buildIntuitionCandidate = (input: IntuitionInput): IntuitionCandidate | null => {
  const previousCore = clampIntuitionLine(input.previousCore, 120);
  const currentAsk = clampIntuitionLine(input.currentAsk, 120);
  const changedPoint = clampIntuitionLine(input.changedPoint, 120);
  const stablePoint = clampIntuitionLine(input.stablePoint, 120);
  const nextFocus = clampIntuitionLine(input.nextFocus, 120);

  if (!currentAsk) return null;

  const depthStage = clampIntuitionLine(input.depthStage, 40);
  const qCode = clampIntuitionLine(input.qCode, 40);
  const phase = clampIntuitionLine(input.phase, 40);
  const eTurn = clampIntuitionLine(input.eTurn, 40);
  const flowDelta = clampIntuitionLine(input.flowDelta, 80);
  const returnStreak = toNumberOrNull(input.returnStreak);
  const topicDigest = clampIntuitionLine(input.topicDigest, 120);
  const conversationLine = clampIntuitionLine(input.conversationLine, 120);

  const hasDelta = Boolean(previousCore && changedPoint);
  const hasStable = Boolean(stablePoint || topicDigest || conversationLine);
  const hasStateMeta = Boolean(depthStage || qCode || phase || eTurn || flowDelta);
  const hasReturn = typeof returnStreak === 'number' && returnStreak > 0;

  const confidence = clampConfidence(
    0.28 +
      (hasDelta ? 0.18 : 0) +
      (hasStable ? 0.12 : 0) +
      (hasStateMeta ? 0.12 : 0) +
      (hasReturn ? 0.08 : 0),
  );

  const coreReading = hasDelta
    ? `前回の焦点から、今回は「${changedPoint}」へ進みが移っている候補があります。`
    : hasStable
      ? `今回の発話は、続いている流れの中で「${currentAsk}」を確かめに来ている候補があります。`
      : `今回の発話は、「${currentAsk}」そのものを中心に読むのが安全です。`;

  const hiddenShift = hasDelta
    ? `変化点は、前回の話を説明する段階から、今回の意味づけや可能性を見に行く段階へ移ったことです。`
    : null;

  const relationHint = /相手|関係|連絡|約束|二人|好き|興味/u.test(
    [currentAsk, previousCore, changedPoint, stablePoint, topicDigest, conversationLine].join(' '),
  )
    ? '相手の本心は断定せず、関係に出ている温度差・動き方・止まり方として扱ってください。'
    : null;

  const writerHint = [
    '直観候補は断定ではなく、返答の方向づけとして使う。',
    'ユーザーの直接依頼を最優先する。',
    hasDelta ? '前回と今回の差分を一言で扱う。' : '',
    hasStable ? '続いている流れを短く受けてから答える。' : '',
    relationHint ? '関係の読みは本心断定ではなく、表に出ている流れとして表現する。' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return {
    source: 'iros_intuition_candidate',
    confidence,
    coreReading,
    hiddenShift,
    relationHint,
    writerHint,
    avoid: [
      '相手の本心を断定しない',
      '外部事実を作らない',
      '診断結果を通常会話へ勝手に混ぜない',
      '内部コードを表に出さない',
      '直観候補を結論として出さない',
    ],
  };
};

export const formatIntuitionSeed = (candidate: IntuitionCandidate | null): string | null => {
  if (!candidate) return null;

  const lines = [
    'INTUITION_CANDIDATE (DO NOT OUTPUT):',
    candidate.coreReading ? `coreReading=${candidate.coreReading}` : '',
    candidate.hiddenShift ? `hiddenShift=${candidate.hiddenShift}` : '',
    candidate.relationHint ? `relationHint=${candidate.relationHint}` : '',
    candidate.writerHint ? `writerHint=${candidate.writerHint}` : '',
    `confidence=${candidate.confidence}`,
    candidate.avoid.length ? `avoid=${candidate.avoid.join(' / ')}` : '',
    `source=${candidate.source}`,
  ].filter(Boolean);

  return lines.length > 2 ? lines.join('\n') : null;
};

