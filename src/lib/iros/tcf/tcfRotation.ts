export type TcfUserReaction =
  | 'accept'
  | 'reject'
  | 'refine'
  | 'ask_more'
  | 'action'
  | 'confused'
  | 'unknown';

export type TcfConvergenceState =
  | 'none'
  | 'focused'
  | 'partial'
  | 'converged'
  | 'unresolved'
  | 'diverged'
  | 'recycle';

export type TcfCDirection =
  | 'none'
  | 'concretize'
  | 'structure_design'
  | 'implementation'
  | 'action_plan'
  | 'relation_boundary'
  | 'diagnosis_deepen'
  | 'memory_seed'
  | 'writer_correction';

export type TcfAnchorEvent =
  | 'choice'
  | 'action'
  | 'reconfirm'
  | 'none';

export type TcfTEvidence = {
  hasT: boolean;
  itxStep: string | null;
  anchorEvent: TcfAnchorEvent | null;
  hasCommittedAnchor: boolean;
  reason: string | null;
};

export type TcfRotationDecision = {
  previousFocus: string | null;
  currentFocus: string | null;
  nextFocus: string | null;
  tEvidence: TcfTEvidence;
  cDirection: TcfCDirection;
  userReaction: TcfUserReaction;
  convergence: TcfConvergenceState;
  shouldPersistFocus: boolean;
  shouldRebuildFocus: boolean;
  shouldPromoteDepth: boolean;
  shouldRouteToC: boolean;
  shouldUseTcfPattern: boolean;
  writerPatternKey: string | null;
  surfacePlanKind: string | null;
  reason: string;
};

export type TcfTEvidenceInput = {
  meta?: any | null;
  extra?: any | null;
  ctxPack?: any | null;
  sriContext?: any | null;
  memoryState?: any | null;
  anchorEntry?: any | null;
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

function firstTrue(...values: unknown[]): boolean {
  return values.some((value) => value === true);
}

function anchorEventValue(value: unknown): string | null {
  if (typeof value === 'string') return firstString(value);

  const record = asRecord(value);
  if (!record) return null;

  return firstString(record.type, record.event, record.anchorEvent, record.anchor_event_type);
}

function normalizeTcfAnchorEvent(value: unknown): TcfAnchorEvent | null {
  const event = firstString(anchorEventValue(value))?.toLowerCase() ?? null;

  if (
    event === 'choice' ||
    event === 'action' ||
    event === 'reconfirm' ||
    event === 'none'
  ) {
    return event;
  }

  return null;
}

function buildTcfTEvidenceReason(args: {
  itxStep: string | null;
  tEntryOk: boolean;
  hasCommittedAnchor: boolean;
  anchorEventRaw: string | null;
}): string | null {
  if (args.itxStep === 'T3') return 'ITX_STEP_T3';
  if (args.itxStep === 'T2') return 'ITX_STEP_T2';
  if (args.tEntryOk) return 'T_ENTRY_OK';
  if (args.hasCommittedAnchor) return 'COMMITTED_ANCHOR';

  if (args.anchorEventRaw && args.anchorEventRaw !== 'none') {
    return `ANCHOR_EVENT_${args.anchorEventRaw.toUpperCase()}`;
  }

  return null;
}

export function readTcfTEvidence(input: TcfTEvidenceInput): TcfTEvidence {
  const meta = asRecord(input.meta) ?? {};
  const extra = asRecord(input.extra) ?? asRecord(meta.extra) ?? {};
  const ctxPack =
    asRecord(input.ctxPack) ??
    asRecord(extra.ctxPack) ??
    asRecord(meta.ctxPack) ??
    {};

  const sriContext =
    asRecord(input.sriContext) ??
    asRecord(ctxPack.sriContext) ??
    asRecord(extra.sriContext) ??
    asRecord(meta.sriContext) ??
    {};

  const intentionContext =
    asRecord(sriContext.intentionContext) ??
    asRecord(sriContext.intentContext) ??
    {};

  const memoryState =
    asRecord(input.memoryState) ??
    asRecord(meta.memoryState) ??
    asRecord(extra.memoryState) ??
    asRecord(ctxPack.memoryState) ??
    {};

  const anchorEntry =
    asRecord(input.anchorEntry) ??
    asRecord(meta.anchorEntry) ??
    asRecord(extra.anchorEntry) ??
    asRecord(ctxPack.anchorEntry) ??
    {};

  const anchorPatch = asRecord(anchorEntry.patch) ?? {};

  const itxStep = firstString(
    meta.itx_step,
    meta.itxStep,
    extra.itx_step,
    extra.itxStep,
    ctxPack.itx_step,
    ctxPack.itxStep,
    sriContext.itx_step,
    sriContext.itxStep,
    intentionContext.itx_step,
    intentionContext.itxStep,
    memoryState.itx_step,
    memoryState.itxStep,
    anchorPatch.itx_step,
    anchorPatch.itxStep,
  );

  const anchorEventRaw = firstString(
    meta.anchor_event_type,
    meta.anchorEventType,
    meta.anchor_event,
    anchorEventValue(meta.anchorEvent),
    extra.anchor_event_type,
    extra.anchorEventType,
    extra.anchor_event,
    anchorEventValue(extra.anchorEvent),
    ctxPack.anchor_event_type,
    ctxPack.anchorEventType,
    ctxPack.anchor_event,
    anchorEventValue(ctxPack.anchorEvent),
    sriContext.anchor_event_type,
    sriContext.anchorEventType,
    sriContext.anchor_event,
    anchorEventValue(sriContext.anchorEvent),
    intentionContext.anchor_event_type,
    intentionContext.anchorEventType,
    intentionContext.anchor_event,
    anchorEventValue(intentionContext.anchorEvent),
    anchorEntry.anchorEvent,
    anchorEntry.anchor_event_type,
    anchorPatch.itx_anchor_event_type,
  )?.toLowerCase() ?? null;

  const anchorEvent = normalizeTcfAnchorEvent(anchorEventRaw);

  const tEntryOk = firstTrue(
    meta.t_entry_ok,
    meta.tEntryOk,
    extra.t_entry_ok,
    extra.tEntryOk,
    ctxPack.t_entry_ok,
    ctxPack.tEntryOk,
    sriContext.t_entry_ok,
    sriContext.tEntryOk,
    intentionContext.t_entry_ok,
    intentionContext.tEntryOk,
    anchorEntry.tEntryOk,
    anchorEntry.t_entry_ok,
  );

  const hasCommittedAnchor = firstTrue(
    meta.has_committed_anchor,
    meta.hasCommittedAnchor,
    extra.has_committed_anchor,
    extra.hasCommittedAnchor,
    ctxPack.has_committed_anchor,
    ctxPack.hasCommittedAnchor,
    sriContext.has_committed_anchor,
    sriContext.hasCommittedAnchor,
    intentionContext.has_committed_anchor,
    intentionContext.hasCommittedAnchor,
    memoryState.has_committed_anchor,
    memoryState.hasCommittedAnchor,
    asRecord(meta.intent_anchor)?.fixed,
    asRecord(extra.intent_anchor)?.fixed,
    asRecord(ctxPack.intent_anchor)?.fixed,
    asRecord(memoryState.intent_anchor)?.fixed,
  );

  const hasAnchorEvent = Boolean(anchorEventRaw && anchorEventRaw !== 'none');
  const hasT = Boolean(
    itxStep === 'T3' ||
      itxStep === 'T2' ||
      tEntryOk ||
      hasCommittedAnchor ||
      hasAnchorEvent,
  );

  return {
    hasT,
    itxStep,
    anchorEvent,
    hasCommittedAnchor,
    reason: buildTcfTEvidenceReason({
      itxStep,
      tEntryOk,
      hasCommittedAnchor,
      anchorEventRaw,
    }),
  };
}

export type ResolveTcfCDirectionInput = {
  userText?: string | null;
  currentFocus?: string | null;
  transferSeed?: any | null;
  memoryIntent?: string | null;
  goalKind?: string | null;
  writerPatternKey?: string | null;
  focusResolution?: any | null;
  meta?: any | null;
  extra?: any | null;
  ctxPack?: any | null;
  sriContext?: any | null;
};

function textFromUnknown(value: unknown): string | null {
  if (typeof value === 'string') return firstString(value);

  const record = asRecord(value);
  if (!record) return null;

  return firstString(
    record.seedText,
    record.text,
    record.focus,
    record.replyFocus,
    record.fromReplyFocus,
    record.toReplyFocus,
    record.humanStateReplyFocus,
    record.CURRENT_REPLY_FOCUS,
    record.SECOND_REPLY_FOCUS,
    record.HUMAN_STATE_REPLY_FOCUS,
    record.REPLY_FOCUS,
  );
}

function joinForTcfMatch(...values: unknown[]): string {
  const parts: string[] = [];

  for (const value of values) {
    const text = textFromUnknown(value);
    if (text) parts.push(text);
  }

  return parts.join('\n').toLowerCase();
}

function hasTcfMatch(text: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

export function resolveTcfCDirection(input: ResolveTcfCDirectionInput): TcfCDirection {
  const meta = asRecord(input.meta) ?? {};
  const extra = asRecord(input.extra) ?? asRecord(meta.extra) ?? {};
  const ctxPack =
    asRecord(input.ctxPack) ??
    asRecord(extra.ctxPack) ??
    asRecord(meta.ctxPack) ??
    {};

  const sriContext =
    asRecord(input.sriContext) ??
    asRecord(ctxPack.sriContext) ??
    asRecord(extra.sriContext) ??
    asRecord(meta.sriContext) ??
    {};

  const intentionContext =
    asRecord(sriContext.intentionContext) ??
    asRecord(sriContext.intentContext) ??
    {};

  const focusResolution =
    asRecord(input.focusResolution) ??
    asRecord(ctxPack.focusResolution) ??
    asRecord(extra.focusResolution) ??
    asRecord(meta.focusResolution) ??
    {};

  const transferSeed =
    input.transferSeed ??
    ctxPack.transferSeed ??
    extra.transferSeed ??
    meta.transferSeed ??
    null;

  const memoryIntent = firstString(
    input.memoryIntent,
    ctxPack.memoryIntent,
    extra.memoryIntent,
    meta.memoryIntent,
    intentionContext.memoryIntent,
  )?.toLowerCase() ?? null;

  const goalKind = firstString(
    input.goalKind,
    ctxPack.goalKind,
    extra.goalKind,
    meta.goalKind,
    intentionContext.goalKind,
  )?.toLowerCase() ?? null;

  const writerPatternKey = firstString(
    input.writerPatternKey,
    ctxPack.writerPatternKey,
    extra.writerPatternKey,
    meta.writerPatternKey,
  )?.toLowerCase() ?? null;

  const text = joinForTcfMatch(
    input.userText,
    input.currentFocus,
    transferSeed,
    focusResolution.focus,
    focusResolution.domain,
    focusResolution.outputShape,
    goalKind,
    memoryIntent,
    writerPatternKey,
  );

  if (
    hasTcfMatch(text, [/違う/u, /そうじゃない/u, /ズレ/u, /戻ってる/u, /もう一回/u, /言い方/u, /硬い/u])
  ) {
    return 'writer_correction';
  }

  if (
    hasTcfMatch(text, [/実装/u, /コード/u, /関数/u, /db/u, /sql/u, /保存/u, /取得/u, /型/u, /ファイル/u, /import/u])
  ) {
    return 'implementation';
  }

  if (
    memoryIntent === 'diagnosis_recall' ||
    hasTcfMatch(text, [/診断/u, /深め/u, /状態/u, /ir/u, /カード/u])
  ) {
    return 'diagnosis_deepen';
  }

  if (
    memoryIntent === 'relationship_recall' ||
    hasTcfMatch(text, [/関係/u, /距離感/u, /連絡/u, /相手/u, /境界線/u, /どう返す/u, /離れる/u, /近づく/u])
  ) {
    return 'relation_boundary';
  }

  if (
    memoryIntent === 'working_rule_recall' ||
    memoryIntent === 'project_context_recall' ||
    memoryIntent === 'past_context_recall' ||
    hasTcfMatch(text, [/覚えて/u, /前の話/u, /記憶/u, /呼び出し/u, /memory/u, /pre-seed/u])
  ) {
    return 'memory_seed';
  }

  if (
    goalKind === 'decide' ||
    hasTcfMatch(text, [/やる/u, /進め/u, /次/u, /手順/u, /どう動く/u, /何から/u, /お願いします/u])
  ) {
    return 'action_plan';
  }

  if (
    hasTcfMatch(text, [/構造/u, /設計/u, /仕様/u, /仕組み/u, /全体像/u, /回路/u, /接続/u, /整理/u, /tcf/u, /sri/u, /focus/u])
  ) {
    return 'structure_design';
  }

  if (
    hasTcfMatch(text, [/具体/u, /形に/u, /落とす/u, /判断基準/u, /扱い方/u])
  ) {
    return 'concretize';
  }

  return 'none';
}

export function detectTcfUserReaction(userText: string | null | undefined): TcfUserReaction {
  const text = String(userText ?? '').trim().toLowerCase();

  if (!text) return 'unknown';

  if (
    hasTcfMatch(text, [
      /違う/u,
      /そうじゃない/u,
      /ズレ/u,
      /外れ/u,
      /戻ってる/u,
      /それは違う/u,
      /そこじゃない/u,
      /もう言ってる/u,
      /深読みしない/u,
    ])
  ) {
    return 'reject';
  }

  if (
    hasTcfMatch(text, [
      /どういうこと/u,
      /よく分から/u,
      /よくわから/u,
      /わからない/u,
      /分からない/u,
      /まだ見えない/u,
      /どこから/u,
      /混乱/u,
      /不明/u,
    ])
  ) {
    return 'confused';
  }

  if (
    hasTcfMatch(text, [
      /だいたい/u,
      /大体/u,
      /近い/u,
      /方向は合/u,
      /方向性は合/u,
      /もう少し/u,
      /でも/u,
      /ただ/u,
      /少し違/u,
      /調整/u,
      /修正/u,
      /言い換/u,
    ])
  ) {
    return 'refine';
  }

  if (
    hasTcfMatch(text, [
      /詳しく/u,
      /もう少し説明/u,
      /教えて/u,
      /どうすれば/u,
      /どうやって/u,
      /どれ/u,
      /何を/u,
      /なにを/u,
      /どこ/u,
      /ありますか/u,
      /できますか/u,
      /\?$/,
      /？$/,
    ])
  ) {
    return 'ask_more';
  }

  if (
    hasTcfMatch(text, [
      /やります/u,
      /進めます/u,
      /進めましょう/u,
      /やろう/u,
      /作って/u,
      /入れて/u,
      /追加/u,
      /実装/u,
      /保存して/u,
      /コミット/u,
      /push/u,
      /プッシュ/u,
      /お願いします/u,
      /お願い/u,
    ])
  ) {
    return 'action';
  }

  if (
    hasTcfMatch(text, [
      /それでいい/u,
      /これでいい/u,
      /それです/u,
      /そういうこと/u,
      /合ってる/u,
      /合っています/u,
      /ok/u,
      /ＯＫ/u,
      /了解/u,
      /承知/u,
      /いいです/u,
      /大丈夫/u,
      /ありがとう/u,
      /ありがとうございます/u,
    ])
  ) {
    return 'accept';
  }

  return 'unknown';
}

export type DecideTcfConvergenceInput = {
  previousFocus?: string | null;
  currentFocus?: string | null;
  userReaction?: TcfUserReaction | null;
  tEvidence?: TcfTEvidence | null;
  cDirection?: TcfCDirection | null;
};

function normalizeTcfFocusText(value: unknown): string | null {
  const text = firstString(value);
  if (!text) return null;

  return text
    .replace(/\s+/g, '')
    .replace(/[。．.、,]/g, '')
    .toLowerCase();
}

function hasDifferentTcfFocus(previousFocus: string | null, currentFocus: string | null): boolean {
  const previous = normalizeTcfFocusText(previousFocus);
  const current = normalizeTcfFocusText(currentFocus);

  if (!previous || !current) return false;

  return previous !== current;
}

export function decideTcfConvergence(
  input: DecideTcfConvergenceInput,
): TcfConvergenceState {
  const previousFocus = firstString(input.previousFocus);
  const currentFocus = firstString(input.currentFocus);
  const userReaction = input.userReaction ?? 'unknown';
  const tEvidence = input.tEvidence ?? null;
  const cDirection = input.cDirection ?? 'none';

  const hasFocus = Boolean(currentFocus || previousFocus);
  const hasT = tEvidence?.hasT === true;
  const hasCDirection = cDirection !== 'none';

  if (cDirection === 'writer_correction' || userReaction === 'reject') {
    return 'diverged';
  }

  if (
    hasDifferentTcfFocus(previousFocus, currentFocus) &&
    (userReaction === 'refine' || userReaction === 'action' || userReaction === 'accept')
  ) {
    return 'recycle';
  }

  if (userReaction === 'refine') {
    return 'partial';
  }

  if (userReaction === 'confused') {
    return 'unresolved';
  }

  if (userReaction === 'ask_more') {
    return hasFocus ? 'partial' : 'unresolved';
  }

  if (userReaction === 'accept') {
    return hasFocus || hasT || hasCDirection ? 'converged' : 'focused';
  }

  if (userReaction === 'action') {
    return hasT || hasCDirection || hasFocus ? 'converged' : 'focused';
  }

  if (hasT && hasCDirection && hasFocus) {
    return 'focused';
  }

  if (hasFocus) {
    return 'focused';
  }

  return 'none';
}


export type BuildTcfRotationDecisionInput = TcfTEvidenceInput &
  ResolveTcfCDirectionInput & {
    previousFocus?: string | null;
    currentFocus?: string | null;
    nextFocus?: string | null;
    userReaction?: TcfUserReaction | null;
    tEvidence?: TcfTEvidence | null;
    cDirection?: TcfCDirection | null;
    convergence?: TcfConvergenceState | null;
  };

function resolveTcfWriterPatternKey(args: {
  cDirection: TcfCDirection;
  convergence: TcfConvergenceState;
}): string | null {
  if (args.cDirection === 'writer_correction' || args.convergence === 'diverged') {
    return 'WRITER_CORRECTION_V1';
  }

  if (
    args.convergence === 'partial' ||
    args.convergence === 'unresolved' ||
    args.convergence === 'recycle'
  ) {
    return 'TCF_REFOCUS_V1';
  }

  if (args.convergence === 'converged') {
    return 'TCF_CONVERGENCE_V1';
  }

  if (args.cDirection === 'implementation') {
    return 'TCF_IMPLEMENTATION_V1';
  }

  if (args.cDirection === 'memory_seed') {
    return 'SEED_DESIGN_V1';
  }

  if (args.cDirection === 'structure_design') {
    return 'STRUCTURE_DESIGN_V1';
  }

  return null;
}

function resolveTcfSurfacePlanKind(args: {
  cDirection: TcfCDirection;
  convergence: TcfConvergenceState;
}): string | null {
  if (args.cDirection === 'writer_correction' || args.convergence === 'diverged') {
    return 'writer_correction';
  }

  if (
    args.convergence === 'partial' ||
    args.convergence === 'unresolved' ||
    args.convergence === 'recycle'
  ) {
    return 'refocus';
  }

  if (args.convergence === 'converged') {
    return 'convergence';
  }

  if (args.cDirection === 'implementation') {
    return 'implementation';
  }

  if (
    args.cDirection === 'structure_design' ||
    args.cDirection === 'concretize' ||
    args.cDirection === 'memory_seed'
  ) {
    return 'structure_design';
  }

  return null;
}

function shouldPersistTcfFocus(args: {
  convergence: TcfConvergenceState;
  tEvidence: TcfTEvidence;
}): boolean {
  if (args.convergence === 'diverged' || args.convergence === 'unresolved') {
    return false;
  }

  if (
    args.convergence === 'converged' ||
    args.convergence === 'partial' ||
    args.convergence === 'focused'
  ) {
    return true;
  }

  return args.tEvidence.hasT === true;
}

function shouldRebuildTcfFocus(convergence: TcfConvergenceState): boolean {
  return (
    convergence === 'partial' ||
    convergence === 'unresolved' ||
    convergence === 'diverged' ||
    convergence === 'recycle'
  );
}

function buildTcfRotationReason(args: {
  tEvidence: TcfTEvidence;
  cDirection: TcfCDirection;
  userReaction: TcfUserReaction;
  convergence: TcfConvergenceState;
}): string {
  return [
    `t=${args.tEvidence.hasT ? args.tEvidence.reason ?? 'HAS_T' : 'NO_T'}`,
    `c=${args.cDirection}`,
    `reaction=${args.userReaction}`,
    `convergence=${args.convergence}`,
  ].join(' / ');
}

export function buildTcfRotationDecision(
  input: BuildTcfRotationDecisionInput,
): TcfRotationDecision {
  const meta = asRecord(input.meta) ?? {};
  const extra = asRecord(input.extra) ?? asRecord(meta.extra) ?? {};
  const ctxPack =
    asRecord(input.ctxPack) ??
    asRecord(extra.ctxPack) ??
    asRecord(meta.ctxPack) ??
    {};

  const focusResolution =
    asRecord(input.focusResolution) ??
    asRecord(ctxPack.focusResolution) ??
    asRecord(extra.focusResolution) ??
    asRecord(meta.focusResolution) ??
    {};

  const transferSeed =
    input.transferSeed ??
    ctxPack.transferSeed ??
    extra.transferSeed ??
    meta.transferSeed ??
    null;

  const hasMemoryRecallNotFoundTurnContract = (() => {
    const extraCtxPack = asRecord(extra.ctxPack) ?? {};
    const metaExtra = asRecord(meta.extra) ?? {};
    const metaExtraCtxPack = asRecord(metaExtra.ctxPack) ?? {};

    const contracts = [
      (input as any)?.turnContract,
      (input as any)?.turnUnderstanding,
      ctxPack.turnContract,
      ctxPack.turnUnderstanding,
      extra.turnContract,
      extra.turnUnderstanding,
      extraCtxPack.turnContract,
      extraCtxPack.turnUnderstanding,
      meta.turnContract,
      meta.turnUnderstanding,
      metaExtra.turnContract,
      metaExtra.turnUnderstanding,
      metaExtraCtxPack.turnContract,
      metaExtraCtxPack.turnUnderstanding,
    ];

    return contracts.some((contract) => {
      const c = asRecord(contract);
      if (!c) return false;

      return (
        String(c.turnTask ?? '').trim() === 'memory_recall_check' &&
        String(c.memoryStatus ?? '').trim() === 'not_found' &&
        String(c.writerAction ?? '').trim() === 'answer_memory_not_found'
      );
    });
  })();

  const previousFocus = firstString(
    input.previousFocus,
    ctxPack.previousFocus,
    extra.previousFocus,
    meta.previousFocus,
  );

  const currentFocus = firstString(
    input.currentFocus,
    ctxPack.currentFocus,
    extra.currentFocus,
    meta.currentFocus,
    focusResolution.focus,
    textFromUnknown(transferSeed),
  );

  const tEvidence =
    input.tEvidence ??
    readTcfTEvidence({
      meta,
      extra,
      ctxPack,
      sriContext: input.sriContext,
      memoryState: input.memoryState,
      anchorEntry: input.anchorEntry,
    });

  const cDirection =
    hasMemoryRecallNotFoundTurnContract
      ? 'none'
      : input.cDirection ??
        resolveTcfCDirection({
          userText: input.userText,
          currentFocus,
          transferSeed,
          memoryIntent: input.memoryIntent,
          goalKind: input.goalKind,
          writerPatternKey: input.writerPatternKey,
          focusResolution,
          meta,
          extra,
          ctxPack,
          sriContext: input.sriContext,
        });

  const userReaction =
    hasMemoryRecallNotFoundTurnContract
      ? 'unknown'
      : input.userReaction ??
        detectTcfUserReaction(input.userText);

  const convergence =
    hasMemoryRecallNotFoundTurnContract
      ? 'none'
      : input.convergence ??
        decideTcfConvergence({
          previousFocus,
          currentFocus,
          userReaction,
          tEvidence,
          cDirection,
        });

  const shouldPersistFocus = hasMemoryRecallNotFoundTurnContract
    ? false
    : shouldPersistTcfFocus({ convergence, tEvidence });

  const shouldRebuildFocus = hasMemoryRecallNotFoundTurnContract
    ? false
    : shouldRebuildTcfFocus(convergence);

  const shouldPromoteDepth =
    !hasMemoryRecallNotFoundTurnContract &&
    (convergence === 'converged' || (tEvidence.hasT && cDirection !== 'none'));

  const shouldRouteToC =
    !hasMemoryRecallNotFoundTurnContract &&
    cDirection !== 'none' &&
    convergence !== 'diverged' &&
    convergence !== 'unresolved';

  const writerPatternKey = hasMemoryRecallNotFoundTurnContract
    ? null
    : resolveTcfWriterPatternKey({ cDirection, convergence });

  const surfacePlanKind = hasMemoryRecallNotFoundTurnContract
    ? null
    : resolveTcfSurfacePlanKind({ cDirection, convergence });

  const shouldUseTcfPattern = hasMemoryRecallNotFoundTurnContract
    ? false
    : Boolean(writerPatternKey || surfacePlanKind);

  return {
    previousFocus,
    currentFocus,
    nextFocus: firstString(input.nextFocus, currentFocus, previousFocus),
    tEvidence,
    cDirection,
    userReaction,
    convergence,
    shouldPersistFocus,
    shouldRebuildFocus,
    shouldPromoteDepth,
    shouldRouteToC,
    shouldUseTcfPattern,
    writerPatternKey,
    surfacePlanKind,
    reason: hasMemoryRecallNotFoundTurnContract
      ? 'memory_recall_not_found_guard / tcf=off'
      : buildTcfRotationReason({
          tEvidence,
          cDirection,
          userReaction,
          convergence,
        }),
  };
}

function compactTcfSeedValue(value: unknown): string | null {
  const text = firstString(value);
  if (!text) return null;

  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tcfSeedLine(key: string, value: unknown): string | null {
  const text = compactTcfSeedValue(value);
  return text ? `${key}=${text}` : null;
}

export function formatTcfRotationSeed(
  decision: TcfRotationDecision | null | undefined,
): string | null {
  if (!decision) return null;

  const lines = [
    'TCF_ROTATION_DECISION (DO NOT OUTPUT):',

    tcfSeedLine('PREVIOUS_FOCUS', decision.previousFocus),
    tcfSeedLine('CURRENT_FOCUS', decision.currentFocus),
    tcfSeedLine('NEXT_FOCUS', decision.nextFocus),

    tcfSeedLine('T_HAS', decision.tEvidence.hasT ? 'true' : 'false'),
    tcfSeedLine('T_STEP', decision.tEvidence.itxStep),
    tcfSeedLine('T_ANCHOR_EVENT', decision.tEvidence.anchorEvent),
    tcfSeedLine('T_COMMITTED_ANCHOR', decision.tEvidence.hasCommittedAnchor ? 'true' : 'false'),
    tcfSeedLine('T_REASON', decision.tEvidence.reason),

    tcfSeedLine('C_DIRECTION', decision.cDirection),
    tcfSeedLine('USER_REACTION', decision.userReaction),
    tcfSeedLine('CONVERGENCE', decision.convergence),

    tcfSeedLine('PERSIST_FOCUS', decision.shouldPersistFocus ? 'true' : 'false'),
    tcfSeedLine('REBUILD_FOCUS', decision.shouldRebuildFocus ? 'true' : 'false'),
    tcfSeedLine('PROMOTE_DEPTH', decision.shouldPromoteDepth ? 'true' : 'false'),
    tcfSeedLine('ROUTE_TO_C', decision.shouldRouteToC ? 'true' : 'false'),
    tcfSeedLine('USE_TCF_PATTERN', decision.shouldUseTcfPattern ? 'true' : 'false'),

    tcfSeedLine('WRITER_PATTERN', decision.writerPatternKey),
    tcfSeedLine('SURFACE_PLAN', decision.surfacePlanKind),
    tcfSeedLine('REASON', decision.reason),
  ].filter((line): line is string => Boolean(line));

  return lines.join('\n').trim();
}
