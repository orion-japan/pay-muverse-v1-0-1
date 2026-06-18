import type { UniversalPreSeedDecision } from './types';
import { classifyMemoryIntent } from './classifyMemoryIntent';
import { detectExitToNormal } from './detectExitToNormal';
import { resolveTargetForPreSeed } from './resolveTarget';
import { resolveRelationForPreSeed } from './resolveRelation';
import { routeMemorySpace } from './routeMemorySpace';
import { buildUniversalSeed } from './buildUniversalSeed';

export async function resolveUniversalPreSeed(args: {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  supabase?: any;
  historyForTurn?: any[];
  meta?: any;
  traceId?: string | null;
}): Promise<UniversalPreSeedDecision | null> {
  const userText = String(args.userText ?? '').trim();

  if (!userText) return null;

  if (detectExitToNormal(userText)) {
    console.log('[IROS/PRE_SEED/UNIVERSAL][EXIT_TO_NORMAL]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      userTextHead: userText.slice(0, 120),
    });
    return null;
  }

  const memoryIntent = classifyMemoryIntent(userText);

  if (memoryIntent === 'normal_chat' || memoryIntent === 'unknown') {
    return null;
  }

  const ctxPack = args.meta?.extra?.ctxPack ?? args.meta?.ctxPack ?? null;

  const resolvedTarget = await resolveTargetForPreSeed({
    userText,
    historyForTurn: args.historyForTurn ?? [],
    ctxPack,
    supabase: args.supabase,
    userCode: args.userCode,
  });

  const resolvedRelation = await resolveRelationForPreSeed({
    userText,
    resolvedTarget,
    userCode: args.userCode,
    supabase: args.supabase,
  });

  const memorySpace = routeMemorySpace({
    memoryIntent,
    resolvedTarget,
    resolvedRelation,
  });

  const sourceAuthority =
    memorySpace === 'relationship'
      ? 'relationship_memory'
      : memorySpace === 'ir_diagnosis'
        ? 'ir_diagnosis_text'
        : memorySpace === 'person'
          ? 'person_intent_state'
          : memorySpace === 'project'
            ? 'project_context_memory'
            : memorySpace === 'long_term'
              ? 'long_term_memory'
              : memorySpace === 'pending_offer'
                ? 'pending_offer'
                : memorySpace === 'active_thread'
                  ? 'active_context_thread'
                  : 'none';

  const seedText = buildUniversalSeed({
    userText,
    memoryIntent,
    memorySpace,
    sourceAuthority,
    sourceText: '',
    resolvedTarget,
    resolvedRelation,
  });

  console.log('[IROS/PRE_SEED/UNIVERSAL][FOUND_CANDIDATE]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode,
    memoryIntent,
    memorySpace,
    sourceAuthority,
    targetKey: resolvedTarget.targetKey,
    relationId: resolvedRelation.relationId,
    userTextHead: userText.slice(0, 120),
  });

  return {
    kind:
      memoryIntent === 'ir_diagnosis_recall'
        ? 'ir_diagnosis_recall'
        : memoryIntent === 'relationship_recall'
          ? 'relationship_recall'
          : memoryIntent === 'person_state_recall'
            ? 'person_state_recall'
            : memoryIntent === 'project_context_recall'
              ? 'project_context_recall'
              : memoryIntent === 'working_rule_recall'
                ? 'working_rule_recall'
                : memoryIntent === 'pending_offer_followup'
                  ? 'pending_offer_followup'
                  : memoryIntent === 'active_thread_followup'
                    ? 'active_thread_followup'
                    : 'memory_recall',

    memoryIntent,
    memorySpace,
    route: 'clarify',

    confidence: 0.35,

    resolvedTarget,
    resolvedRelation,

    sourceAuthority,
    sourceKind: null,
    sourceId: null,
    sourceText: null,

    seedText,
    writerInput: null,

    directReply: null,

    shouldUsePreSeedWriter: false,
    shouldBypassNormalWriter: false,
    shouldBypassRephrase: false,
    shouldSuppressHistoryForWriter: false,
    shouldSuppressSimilarFlow: false,
    shouldSuppressSlotPlan: false,
    shouldSuppressMemoryDelta: false,
    shouldSuppressNormalResonance: false,

    shouldOpenContextThread: false,
    contextThreadCode: null,

    ctxPackPatch: {
      universalPreSeedCandidate: true,
      memoryIntent,
      memorySpace,
      sourceAuthority,
      resolvedTarget,
      resolvedRelation,
      seedText,
    },

    metaPatch: {
      universalPreSeedCandidate: true,
      memoryIntent,
      memorySpace,
      sourceAuthority,
    },

    debug: {
      reason: 'universal_preseed_candidate_only_not_connected',
      matchedPattern: null,
      targetKey: resolvedTarget.targetKey,
      relationId: resolvedRelation.relationId,
      routeReason: 'foundation_only',
    },
  };
}
