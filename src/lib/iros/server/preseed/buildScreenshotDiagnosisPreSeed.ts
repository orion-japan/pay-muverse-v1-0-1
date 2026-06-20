import type { PreSeedDecision, ResolvePreSeedDecisionArgs } from './types';
import { buildScreenshotDiagnosisSeed } from './buildScreenshotDiagnosisSeed';
import { buildScreenshotDiagnosisDirectReply } from './buildScreenshotDiagnosisDirectReply';
import { buildCognitionMap } from '../../cognition/buildCognitionMap';
import { cognitionMapToSeedText } from '../../cognition/cognitionMap';
import { buildPreSeedTcfStarter } from './preSeedTcfStarter';

function normalizeDiagnosisRow(row: any): {
  displayId: number | null;
  diagnosisText: string;
  raw: any;
} {
  const displayIdRaw =
    row?.display_id ??
    row?.displayId ??
    row?.id ??
    null;

  const displayId =
    typeof displayIdRaw === 'number'
      ? displayIdRaw
      : Number.parseInt(String(displayIdRaw ?? ''), 10);

  const diagnosisText = String(
    row?.diagnosis_text ??
      row?.diagnosisText ??
      row?.result_text ??
      row?.text ??
      row?.assistant_text ??
      ''
  ).trim();

  return {
    displayId: Number.isFinite(displayId) ? displayId : null,
    diagnosisText,
    raw: row,
  };
}

async function fetchScreenshotDiagnosisByDisplayId(args: {
  supabase: any;
  userCode: string;
  displayId: number;
}): Promise<any | null> {
  const { supabase, userCode, displayId } = args;

  if (!supabase?.from) return null;

  const baseSelect =
    'id, display_id, user_code, conversation_id, source, mode, diagnosis_text, diagnosis_seed_json, used_at, created_at';

  const byDisplay = await supabase
    .from('mu_screenshot_diagnosis_logs')
    .select(baseSelect)
    .eq('user_code', userCode)
    .eq('display_id', displayId)
    .not('diagnosis_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byDisplay?.error) {
    console.warn('[IROS/PRE_SEED_ENGINE][SCREENSHOT_FETCH_BY_DISPLAY_FAILED]', {
      userCode,
      displayId,
      error: byDisplay.error?.message ?? byDisplay.error,
    });
  }

  if (byDisplay?.data) return byDisplay.data;

  const byId = await supabase
    .from('mu_screenshot_diagnosis_logs')
    .select(baseSelect)
    .eq('user_code', userCode)
    .eq('id', String(displayId))
    .not('diagnosis_text', 'is', null)
    .maybeSingle();

  if (byId?.error) {
    console.warn('[IROS/PRE_SEED_ENGINE][SCREENSHOT_FETCH_BY_ID_FAILED]', {
      userCode,
      displayId,
      error: byId.error?.message ?? byId.error,
    });
  }

  if (byId?.data) return byId.data;

  return null;
}

export async function buildScreenshotDiagnosisPreSeed(args: ResolvePreSeedDecisionArgs & {
  displayId: number;
  matchedPattern?: string | null;
}): Promise<PreSeedDecision> {
  const {
    userText,
    userCode,
    conversationId = null,
    supabase,
    displayId,
    traceId = null,
    matchedPattern = 'screenshot_diagnosis_id_continuation',
  } = args;

  const row = await fetchScreenshotDiagnosisByDisplayId({
    supabase,
    userCode,
    displayId,
  });

  const normalized = normalizeDiagnosisRow(row);
  const diagnosisText = normalized.diagnosisText;

  if (!row || !diagnosisText) {
    const decision: PreSeedDecision = {
      kind: 'screenshot_diagnosis_boot',
      confidence: row ? 0.6 : 0.3,
      sourceAuthority: 'screenshot_diagnosis_text',
      sourceKind: 'mu_screenshot_diagnosis_logs',
      sourceId: displayId,
      sourceText: diagnosisText || null,
      route: 'clarify',
      seedText: null,
      directReply:
        `スクショ診断ID:${displayId}は見つかりましたが、診断本文を取得できませんでした。保存ログの diagnosis_text を確認してください。`,
      shouldBypassWriter: true,
      shouldBypassRephrase: true,
      shouldUsePreSeedWriter: true,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      shouldSuppressSlotPlan: true,
      shouldSuppressMemoryDelta: true,
      shouldSuppressIntuitionCandidate: true,
      shouldSuppressNormalResonance: true,
      shouldOpenContextThread: false,
      contextThreadCode: null,
      ctxPackPatch: {
        presentationKind: 'screenshot_diagnosis_followup',
        screenshotDiagnosisFollowup: true,
        contextMode: 'diagnosis_context',
        contextAuthority: 'screenshot_diagnosis',
        writerSourceAuthority: 'diagnosisText',
        goalKind: 'clarify',
        targetKind: 'clarify',
        replyGoal: { kind: 'clarify', questionsMax: 0 },
        question: null,
      },
      metaPatch: {
        presentationKind: 'screenshot_diagnosis_followup',
        screenshotDiagnosisFollowup: true,
        contextMode: 'diagnosis_context',
        contextAuthority: 'screenshot_diagnosis',
      },
      debug: {
        reason: 'screenshot_diagnosis_missing_text',
        matchedPattern: matchedPattern ?? null,
        extractedId: displayId,
        sourceTextHead: diagnosisText.slice(0, 160),
      },
    };

    console.log('[IROS/PRE_SEED_ENGINE][DECISION]', {
      traceId,
      conversationId,
      userCode,
      kind: decision.kind,
      confidence: decision.confidence,
      sourceAuthority: decision.sourceAuthority,
      sourceKind: decision.sourceKind,
      sourceId: decision.sourceId,
      route: decision.route,
      shouldBypassWriter: decision.shouldBypassWriter,
      shouldBypassRephrase: decision.shouldBypassRephrase,
      sourceTextLen: String(decision.sourceText ?? '').length,
      seedLen: String(decision.seedText ?? '').length,
      directReplyLen: String(decision.directReply ?? '').length,
      directReplyHead: String(decision.directReply ?? '').slice(0, 160),
    });

    return decision;
  }

  const sourceId = normalized.displayId ?? displayId;
  const contextThreadCode = `user:${userCode}:screenshot:${sourceId}`;

  const seedText = buildScreenshotDiagnosisSeed({
    displayId: sourceId,
    userText,
    diagnosisText,
  });

  const cognitionMap = buildCognitionMap({
    userText,
    targetLabel: `スクショ診断ID:${sourceId}`,
    targetKey: `screenshot:${sourceId}`,
    sourceKind: 'diagnosis_text',
    sourceText: diagnosisText,
    debug: {
      source: 'buildScreenshotDiagnosisPreSeed',
      displayId: sourceId,
      matchedPattern,
    },
  });

  const cognitionMapSeedText = cognitionMapToSeedText(cognitionMap);
  const tcfStarter = buildPreSeedTcfStarter({
    userText,
    decisionKind: 'screenshot_diagnosis_followup',
    sourceAuthority: 'screenshot_diagnosis_text',
    cognitionMap,
  });

  const writerInput = {
    writerKind: 'diagnosis_writer' as const,
    displayId: sourceId,
    userText,
    sourceText: diagnosisText,
    seedText,
    cognitionMap,
    cognitionMapSeedText,
    tcfStarter,
    traceId,
    conversationId,
    userCode,
  };

  const directReply = buildScreenshotDiagnosisDirectReply({
    displayId: sourceId,
    diagnosisText,
  });

  const ctxPackPatch = {
    contextMode: 'diagnosis_context',
    contextAuthority: 'screenshot_diagnosis',
    writerSourceAuthority: 'diagnosisText',
    presentationKind: 'screenshot_diagnosis_followup',
    screenshotDiagnosisFollowup: true,

    situationTopic: `スクショ診断ID:${sourceId}`,
    situationSummary: `スクショ診断ID:${sourceId}の続き相談`,

    activeContextFrame: {
      kind: 'diagnosis',
      diagnosisType: 'screenshot',
      displayId: sourceId,
      source: 'mu_screenshot_diagnosis_logs',
      sourceText: diagnosisText,
      hasSeed: true,
    },

    contextThread: {
      code: contextThreadCode,
      sourceKind: 'screenshot_diagnosis',
      sourceId,
      sourceAuthority: 'diagnosisText',
    },

    continuityKind: 'screenshot_diagnosis_followup',
    diagnosisContextStatus: 'active',

    cognitionMap,
    cognitionMapSeedText,
    cognitionMapApplied: true,
    tcfStarter,
    preSeedTcfStarterApplied: true,

    goalKind: 'clarify',
    targetKind: 'clarify',
    replyGoal: { kind: 'clarify', questionsMax: 0 },
    question: null,

    llmRewriteSeed: seedText,
    slotPlanSeed: seedText,
    memorySeedText: seedText,
    memoryPreSeedText: seedText,

    similarFlowSeed: '',
    similarFlowDebug: null,
    historyForWriter: [],
  };

  const decision: PreSeedDecision = {
    kind: 'screenshot_diagnosis_boot',
    confidence: 1,

    sourceAuthority: 'screenshot_diagnosis_text',
    sourceKind: 'mu_screenshot_diagnosis_logs',
    sourceId,
    sourceText: diagnosisText,

    route: 'diagnosis_writer',

    seedText,
    directReply,
    writerInput,
    cognitionMap,
    cognitionMapSeedText,
    tcfStarter,

    shouldBypassWriter: true,
    shouldBypassRephrase: true,
    shouldUsePreSeedWriter: true,
    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: true,
    shouldSuppressMemoryDelta: true,
    shouldSuppressIntuitionCandidate: true,
    shouldSuppressNormalResonance: true,

    shouldOpenContextThread: true,
    contextThreadCode,

    ctxPackPatch,
    metaPatch: {
      presentationKind: 'screenshot_diagnosis_followup',
      screenshotDiagnosisFollowup: true,
      contextMode: 'diagnosis_context',
      contextAuthority: 'screenshot_diagnosis',
      writerSourceAuthority: 'diagnosisText',
      continuityKind: 'screenshot_diagnosis_followup',
      diagnosisContextStatus: 'active',
      cognitionMap,
      cognitionMapSeedText,
      cognitionMapApplied: true,
      tcfStarter,
      preSeedTcfStarterApplied: true,
      llmRewriteSeed: seedText,
      slotPlanSeed: seedText,
      memorySeedText: seedText,
      memoryPreSeedText: seedText,
      similarFlowSeed: '',
      similarFlowDebug: null,
      historyForWriter: [],
      goalKind: 'clarify',
      targetKind: 'clarify',
      replyGoal: { kind: 'clarify', questionsMax: 0 },
      question: null,
    },

    debug: {
      reason: 'matched_screenshot_diagnosis_id_followup',
      matchedPattern: matchedPattern ?? null,
      extractedId: sourceId,
      sourceTextHead: diagnosisText.slice(0, 160),
      seedHead: seedText.slice(0, 160),
      directReplyHead: directReply.slice(0, 160),
      cognitionMapApplied: true,
      cognitionMapRelationCode: cognitionMap.relationCode,
      cognitionMapProgress: cognitionMap.progress,
      cognitionMapTriggerKind: cognitionMap.trigger.kind,
      cognitionMapGapState: cognitionMap.gap.state,
      tcfStarterApplied: true,
      tcfStarterDirection: tcfStarter.cDirection,
    },
  };

  console.log('[IROS/PRE_SEED_ENGINE][DECISION]', {
    traceId,
    conversationId,
    userCode,
    kind: decision.kind,
    confidence: decision.confidence,
    sourceAuthority: decision.sourceAuthority,
    sourceKind: decision.sourceKind,
    sourceId: decision.sourceId,
    route: decision.route,
    shouldBypassWriter: decision.shouldBypassWriter,
    shouldBypassRephrase: decision.shouldBypassRephrase,
    shouldSuppressHistoryForWriter: decision.shouldSuppressHistoryForWriter,
    shouldSuppressSimilarFlow: decision.shouldSuppressSimilarFlow,
    shouldSuppressSlotPlan: decision.shouldSuppressSlotPlan,
    shouldSuppressNormalResonance: decision.shouldSuppressNormalResonance,
    sourceTextLen: String(decision.sourceText ?? '').length,
    seedLen: String(decision.seedText ?? '').length,
    directReplyLen: String(decision.directReply ?? '').length,
    sourceTextHead: String(decision.sourceText ?? '').slice(0, 160),
    seedHead: String(decision.seedText ?? '').slice(0, 160),
    directReplyHead: String(decision.directReply ?? '').slice(0, 160),
    cognitionMapRelationCode: cognitionMap.relationCode,
    cognitionMapProgress: cognitionMap.progress,
    tcfStarterDirection: tcfStarter.cDirection,
    tcfStarterReaction: tcfStarter.userReaction,
    tcfStarterConvergence: tcfStarter.convergence,
  });

  return decision;
}
