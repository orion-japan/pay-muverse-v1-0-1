export type WriterDeviationFlags = {
  tooAnalytical: boolean;
  tooListLike: boolean;
  previousReplyRephraseLeak: boolean;
  similarFlowLeak: boolean;
  tooCertainAboutOther: boolean;
  sourceMissing: boolean;
};

export type WriterDeviationCheckResult = {
  shouldWarn: boolean;
  shouldRewrite: false;
  reasons: string[];
  flags: WriterDeviationFlags;
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, any>;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function hasAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function countListLikeLines(text: string): number {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[・\-*]\s+|\d{1,2}[.)]\s+|[①②③④⑤⑥⑦⑧⑨⑩]\s*)/.test(line))
    .length;
}

function readPreSeedSourceText(meta: any): string | null {
  const m = asRecord(meta) ?? {};
  const extra = asRecord(m.extra) ?? {};
  const ctxPack = asRecord(extra.ctxPack) ?? asRecord(m.ctxPack) ?? {};
  const cognitionMap = asRecord(extra.cognitionMap) ?? asRecord(ctxPack.cognitionMap) ?? asRecord(m.cognitionMap) ?? {};

  return firstString(
    extra.sourceText,
    extra.preSeedSourceText,
    extra.cognitionMapSeedText,
    ctxPack.sourceText,
    ctxPack.preSeedSourceText,
    ctxPack.cognitionMapSeedText,
    m.sourceText,
    m.preSeedSourceText,
    m.cognitionMapSeedText,
    cognitionMap.sourceText,
    cognitionMap.source_text,
    cognitionMap.summary,
  );
}

function hasPreSeedSignal(meta: any): boolean {
  const m = asRecord(meta) ?? {};
  const extra = asRecord(m.extra) ?? {};
  const ctxPack = asRecord(extra.ctxPack) ?? asRecord(m.ctxPack) ?? {};

  return Boolean(
    extra.preSeedDecision ||
      extra.preseedDecision ||
      extra.preSeedKind ||
      extra.preseedKind ||
      extra.cognitionMap ||
      extra.tcfStarter ||
      ctxPack.preSeedDecision ||
      ctxPack.preseedDecision ||
      ctxPack.preSeedKind ||
      ctxPack.preseedKind ||
      ctxPack.cognitionMap ||
      ctxPack.tcfStarter ||
      m.preSeedDecision ||
      m.preseedDecision ||
      m.cognitionMap ||
      m.tcfStarter,
  );
}

/**
 * Writer Deviation Check
 *
 * 目的:
 * - Writer の本文を保存する直前に、Pre-SEED / CognitionMap / TCF からのズレを検出する。
 * - v1 では本文の自動書き換えはしない。
 * - ログと meta.extra.writerDeviationCheck への保存だけ行う。
 */
export function detectWriterDeviation(input: {
  text: string;
  meta?: any | null;
}): WriterDeviationCheckResult {
  const text = String(input.text ?? '').trim();
  const meta = input.meta ?? null;

  const flags: WriterDeviationFlags = {
    tooAnalytical: false,
    tooListLike: false,
    previousReplyRephraseLeak: false,
    similarFlowLeak: false,
    tooCertainAboutOther: false,
    sourceMissing: false,
  };

  flags.tooAnalytical = hasAny(text, [
    /描かれています/u,
    /示されています/u,
    /表れています/u,
    /整理すると/u,
    /ポイントは/u,
    /具体的には/u,
    /要するに/u,
    /この文章は/u,
    /この会話は/u,
  ]);

  flags.tooListLike = countListLikeLines(text) >= 3;

  flags.previousReplyRephraseLeak = hasAny(text, [
    /previous_reply_rephrase/u,
    /前の返答/u,
    /直前の返答/u,
    /言い換え/u,
    /先ほどの返答/u,
  ]);

  flags.similarFlowLeak = hasAny(text, [
    /SimilarFlow/u,
    /similar flow/ui,
    /似た流れ/u,
    /類似フロー/u,
  ]);

  flags.tooCertainAboutOther = hasAny(text, [
    /本音は/u,
    /本心では/u,
    /絶対に/u,
    /間違いなく/u,
    /確実に/u,
    /必ずそう/u,
    /相手は.*決めている/u,
    /相手は.*思っている/u,
  ]);

  const preSeedSignal = hasPreSeedSignal(meta);
  const sourceText = readPreSeedSourceText(meta);
  flags.sourceMissing = Boolean(preSeedSignal && !sourceText);

  const reasons = Object.entries(flags)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  return {
    shouldWarn: reasons.length > 0,
    shouldRewrite: false,
    reasons,
    flags,
  };
}
