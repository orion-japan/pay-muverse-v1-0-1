export type DepthBand = 'S' | 'F' | 'R' | 'C' | 'I' | 'T';

export type MeaningfulDepthDecisionKind =
  | 'promote'
  | 'support'
  | 'watch'
  | 'degrade'
  | 'ignore';

export type MeaningfulDepthTransitionReason =
  | 'invalid_depth'
  | 'ignored_technical_turn'
  | 'ignored_short_ack'
  | 'strong_t_or_anchor_evidence'
  | 'focus_or_transfer_evidence'
  | 'structure_design_implementation_request'
  | 'same_high_band_support'
  | 'upward_band_transition'
  | 'temporary_lower_access'
  | 'repeated_lower_access_watch'
  | 'no_meaningful_transition';

export type MeaningfulDepthTrendInput = {
  previousDepthStage?: string | null;
  depthStageNow?: string | null;
  userText?: string | null;
  meta?: any;
  previousDepthTrend?: any;
};

export type MeaningfulDepthTrendResult = {
  kind: MeaningfulDepthDecisionKind;
  reason: MeaningfulDepthTransitionReason;
  fromDepthStage: string | null;
  toDepthStage: string | null;
  fromBand: DepthBand | null;
  toBand: DepthBand | null;
  evidenceScore: number;
  isMeaningful: boolean;
  shouldAffectLongDepth: boolean;
  shouldAffectActiveDepth: boolean;
  shouldPromote: boolean;
  shouldSupport: boolean;
  shouldWatchDrop: boolean;
  shouldDegrade: boolean;
  notes: string[];
};

const BAND_ORDER: Record<DepthBand, number> = {
  S: 1,
  F: 2,
  R: 3,
  C: 4,
  I: 5,
  T: 6,
};

function normalizeDepthStage(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (/^[SFRCIT][123]$/.test(s)) return s;
  return null;
}

function bandOf(depthStage: string | null): DepthBand | null {
  if (!depthStage) return null;
  const b = depthStage[0];
  if (b === 'S' || b === 'F' || b === 'R' || b === 'C' || b === 'I' || b === 'T') return b;
  return null;
}

function pickString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function includesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function isTechnicalOrLogTurn(userText: string): boolean {
  const t = userText.trim();
  if (!t) return true;

  if (/^(ok|OK|はい|うん|了解|ありがとう|ありがとうございます|できました|通りました|しました)[。！!]*$/u.test(t)) {
    return true;
  }

  if (
    includesAny(t, [
      /Windows PowerShell/u,
      /PS C:\\/u,
      /\bnpm run\b/u,
      /\bnpx tsc\b/u,
      /\bgit status\b/u,
      /\bgit diff\b/u,
      /\bgit log\b/u,
      /\bgit add\b/u,
      /\bgit commit\b/u,
      /\bgit push\b/u,
      /Select-String/u,
      /Get-Content/u,
      /LineNumber\s*:/u,
      /Path\s*:/u,
      /typecheck/u,
    ])
  ) {
    return true;
  }

  return false;
}

function readFocusEvidence(meta: any): string | null {
  const extra = meta?.extra ?? null;
  const ctxPack = extra?.ctxPack ?? meta?.ctxPack ?? null;
  const flowSeed = extra?.flowSeed ?? meta?.flowSeed ?? null;
  const transfer = ctxPack?.transferSeed ?? extra?.transferSeed ?? meta?.transferSeed ?? null;

  return pickString(
    meta?.focus,
    meta?.FOCUS,
    extra?.focus,
    extra?.FOCUS,
    ctxPack?.focus,
    ctxPack?.FOCUS,
    transfer?.fromReplyFocus,
    transfer?.humanStateReplyFocus,
    transfer?.toReplyFocus,
    transfer?.CURRENT_REPLY_FOCUS,
    transfer?.HUMAN_STATE_REPLY_FOCUS,
    typeof flowSeed === 'string' && /FOCUS:/u.test(flowSeed) ? flowSeed : null,
  );
}

function hasTransferOrFocusEvidence(meta: any): boolean {
  const focus = readFocusEvidence(meta);
  if (focus && focus.length >= 6) return true;

  const extra = meta?.extra ?? null;
  const ctxPack = extra?.ctxPack ?? meta?.ctxPack ?? null;
  const flow = meta?.flow ?? extra?.flow ?? ctxPack?.flow ?? null;

  return Boolean(
    ctxPack?.transitionMeaning ||
      extra?.transitionMeaning ||
      meta?.transitionMeaning ||
      flow?.delta ||
      flow?.transitionMeaning ||
      ctxPack?.convEvidence?.advance ||
      ctxPack?.CONV_EVIDENCE?.advance ||
      extra?.convEvidence?.advance ||
      extra?.CONV_EVIDENCE?.advance,
  );
}

function hasStrongTOrAnchorEvidence(meta: any): boolean {
  const extra = meta?.extra ?? null;
  const ctxPack = extra?.ctxPack ?? meta?.ctxPack ?? null;

  const itxStep = pickString(
    meta?.itx_step,
    meta?.itxStep,
    extra?.itx_step,
    extra?.itxStep,
    ctxPack?.itx_step,
    ctxPack?.itxStep,
  );

  const anchorEvent = pickString(
    meta?.anchor_event_type,
    meta?.anchorEventType,
    meta?.anchor_event,
    meta?.anchorEvent,
    extra?.anchor_event_type,
    extra?.anchorEventType,
    ctxPack?.anchor_event_type,
    ctxPack?.anchorEventType,
  );

  return Boolean(
    itxStep === 'T3' ||
      itxStep === 'T2' ||
      meta?.t_entry_ok === true ||
      meta?.tEntryOk === true ||
      extra?.t_entry_ok === true ||
      extra?.tEntryOk === true ||
      meta?.has_committed_anchor === true ||
      meta?.hasCommittedAnchor === true ||
      extra?.has_committed_anchor === true ||
      extra?.hasCommittedAnchor === true ||
      (anchorEvent && anchorEvent !== 'none'),
  );
}

function isStructureDesignImplementationRequest(userText: string): boolean {
  return includesAny(userText, [
    /構造/u,
    /設計/u,
    /実装/u,
    /仕組み/u,
    /保存先/u,
    /DB/u,
    /SQL/u,
    /コード/u,
    /関数/u,
    /仕様/u,
    /手順/u,
    /接続/u,
    /FOCUS/u,
    /TCF/u,
    /SRI/u,
    /SRITCF/u,
    /意味ある移行/u,
    /長期深度/u,
  ]);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function computeMeaningfulDepthTrend(input: MeaningfulDepthTrendInput): MeaningfulDepthTrendResult {
  const fromDepthStage = normalizeDepthStage(input.previousDepthStage);
  const toDepthStage = normalizeDepthStage(input.depthStageNow);
  const fromBand = bandOf(fromDepthStage);
  const toBand = bandOf(toDepthStage);
  const userText = String(input.userText ?? '').trim();
  const meta = input.meta ?? {};
  const previousTrend = input.previousDepthTrend ?? {};

  const notes: string[] = [];

  if (!toDepthStage || !toBand) {
    return {
      kind: 'ignore',
      reason: 'invalid_depth',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore: 0,
      isMeaningful: false,
      shouldAffectLongDepth: false,
      shouldAffectActiveDepth: false,
      shouldPromote: false,
      shouldSupport: false,
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['depthStageNow is not a supported S/F/R/C/I/T stage.'],
    };
  }

  if (isTechnicalOrLogTurn(userText)) {
    return {
      kind: 'ignore',
      reason: userText.length <= 12 ? 'ignored_short_ack' : 'ignored_technical_turn',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore: 0,
      isMeaningful: false,
      shouldAffectLongDepth: false,
      shouldAffectActiveDepth: false,
      shouldPromote: false,
      shouldSupport: false,
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['Technical/log/short acknowledgement turn is ignored for long depth.'],
    };
  }

  const fromRank = fromBand ? BAND_ORDER[fromBand] : 0;
  const toRank = BAND_ORDER[toBand];

  const strongT = hasStrongTOrAnchorEvidence(meta);
  const focusEvidence = hasTransferOrFocusEvidence(meta);
  const structureRequest = isStructureDesignImplementationRequest(userText);

  let evidenceScore = 0;
  if (strongT) evidenceScore += 0.45;
  if (focusEvidence) evidenceScore += 0.28;
  if (structureRequest) evidenceScore += 0.22;
  if (toRank >= 3) evidenceScore += 0.15;
  if (fromRank > 0 && toRank > fromRank) evidenceScore += 0.18;
  if (fromRank > 0 && toRank === fromRank && toRank >= 3) evidenceScore += 0.12;

  evidenceScore = clamp01(evidenceScore);

  if (strongT) {
    return {
      kind: 'promote',
      reason: 'strong_t_or_anchor_evidence',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: true,
      shouldAffectLongDepth: true,
      shouldAffectActiveDepth: true,
      shouldPromote: true,
      shouldSupport: false,
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['T or anchor evidence can promote long depth after repetition.'],
    };
  }

  if (focusEvidence && toRank >= 3) {
    return {
      kind: fromRank > 0 && toRank > fromRank ? 'promote' : 'support',
      reason: 'focus_or_transfer_evidence',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: true,
      shouldAffectLongDepth: true,
      shouldAffectActiveDepth: true,
      shouldPromote: fromRank > 0 && toRank > fromRank,
      shouldSupport: !(fromRank > 0 && toRank > fromRank),
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['FOCUS/transfer evidence makes this a meaningful SRITCF transition.'],
    };
  }

  if (structureRequest && toRank >= 3) {
    return {
      kind: fromRank > 0 && toRank > fromRank ? 'promote' : 'support',
      reason: 'structure_design_implementation_request',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: true,
      shouldAffectLongDepth: true,
      shouldAffectActiveDepth: true,
      shouldPromote: fromRank > 0 && toRank > fromRank,
      shouldSupport: !(fromRank > 0 && toRank > fromRank),
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['Structure/design/implementation request supports C/I/T access.'],
    };
  }

  if (fromRank > 0 && toRank > fromRank && evidenceScore >= 0.25) {
    return {
      kind: 'promote',
      reason: 'upward_band_transition',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: true,
      shouldAffectLongDepth: true,
      shouldAffectActiveDepth: true,
      shouldPromote: true,
      shouldSupport: false,
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['Upward band transition has enough evidence to count.'],
    };
  }

  if (fromRank >= 3 && toRank === fromRank) {
    return {
      kind: 'support',
      reason: 'same_high_band_support',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: true,
      shouldAffectLongDepth: true,
      shouldAffectActiveDepth: true,
      shouldPromote: false,
      shouldSupport: true,
      shouldWatchDrop: false,
      shouldDegrade: false,
      notes: ['Same high band supports the existing long depth.'],
    };
  }

  if (fromRank >= 3 && toRank < fromRank) {
    const prevWatchCount =
      typeof previousTrend?.drop_watch_count === 'number' && Number.isFinite(previousTrend.drop_watch_count)
        ? previousTrend.drop_watch_count
        : 0;

    const nextWatchCount = prevWatchCount + 1;
    const shouldDegrade = nextWatchCount >= 8 && evidenceScore < 0.2;

    return {
      kind: shouldDegrade ? 'degrade' : 'watch',
      reason: shouldDegrade ? 'repeated_lower_access_watch' : 'temporary_lower_access',
      fromDepthStage,
      toDepthStage,
      fromBand,
      toBand,
      evidenceScore,
      isMeaningful: false,
      shouldAffectLongDepth: shouldDegrade,
      shouldAffectActiveDepth: true,
      shouldPromote: false,
      shouldSupport: false,
      shouldWatchDrop: !shouldDegrade,
      shouldDegrade,
      notes: [
        shouldDegrade
          ? 'Repeated lower access without higher evidence can degrade long depth.'
          : 'Lower access is treated as watch first, not immediate degradation.',
      ],
    };
  }

  return {
    kind: 'ignore',
    reason: 'no_meaningful_transition',
    fromDepthStage,
    toDepthStage,
    fromBand,
    toBand,
    evidenceScore,
    isMeaningful: false,
    shouldAffectLongDepth: false,
    shouldAffectActiveDepth: true,
    shouldPromote: false,
    shouldSupport: false,
    shouldWatchDrop: false,
    shouldDegrade: false,
    notes: ['No meaningful SRITCF transition evidence.'],
  };
}

