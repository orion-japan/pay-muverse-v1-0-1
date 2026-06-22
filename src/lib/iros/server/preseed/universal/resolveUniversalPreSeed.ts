import type { UniversalPreSeedDecision } from './types';
import { classifyMemoryIntent } from './classifyMemoryIntent';
import { detectExitToNormal } from './detectExitToNormal';
import { resolveTargetForPreSeed } from './resolveTarget';
import { resolveRelationForPreSeed } from './resolveRelation';
import { routeMemorySpace } from './routeMemorySpace';
import { buildUniversalSeed } from './buildUniversalSeed';

function getUniversalConversationScopeFlags(metaRaw: any): {
  blockPastContext: boolean;
  allowResolvedReferenceFromHistory: boolean;
  allowPersonMemory: boolean;
  allowRelationshipMemory: boolean;
  reason: string | null;
} {
  const meta = metaRaw && typeof metaRaw === 'object' ? metaRaw : {};

  const ctxPack =
    meta?.ctxPack && typeof meta.ctxPack === 'object'
      ? meta.ctxPack
      : meta?.extra?.ctxPack && typeof meta.extra.ctxPack === 'object'
        ? meta.extra.ctxPack
        : {};

  const scope =
    meta?.conversationScope && typeof meta.conversationScope === 'object'
      ? meta.conversationScope
      : ctxPack?.conversationScope && typeof ctxPack.conversationScope === 'object'
        ? ctxPack.conversationScope
        : {};

  const reason = String(
    scope.reason ??
      meta?.conversationScopeReason ??
      ctxPack?.conversationScopeReason ??
      '',
  ) || null;

  const blockPastContext =
    scope.isFreshConversation === true ||
    reason === 'fresh_conversation_without_explicit_past_reference';

  const flag = (key: string, fallback: boolean): boolean => {
    const value = scope[key] ?? meta[key] ?? ctxPack[key];
    return typeof value === 'boolean' ? value : fallback;
  };

  return {
    blockPastContext,
    allowResolvedReferenceFromHistory:
      !blockPastContext &&
      flag('allowResolvedReferenceFromHistory', true) &&
      meta?.disableResolvedReferenceFromHistory !== true,
    allowPersonMemory:
      !blockPastContext &&
      flag('allowPersonMemory', true) &&
      meta?.disableLongTermPersonContext !== true,
    allowRelationshipMemory:
      !blockPastContext &&
      flag('allowRelationshipMemory', true) &&
      meta?.disableRelationshipContext !== true,
    reason,
  };
}

function shouldSuppressUniversalMemoryIntentByScope(
  memoryIntent: string,
  scope: ReturnType<typeof getUniversalConversationScopeFlags>,
): boolean {
  if (scope.blockPastContext) return true;

  if (memoryIntent === 'ir_diagnosis_recall') {
    return !scope.allowResolvedReferenceFromHistory;
  }

  if (
    memoryIntent === 'person_state_recall' ||
    memoryIntent === 'active_thread_followup'
  ) {
    return !scope.allowPersonMemory;
  }

  if (memoryIntent === 'relationship_recall') {
    return !scope.allowRelationshipMemory;
  }

  return false;
}
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

  const explicitContextReset =
    detectExitToNormal(userText) ||
    /^(別件です|別件です。|別件|新規です|新規です。|新規|これは別の相談|話を変えます|話を変えて|前の話は置いておいて|前の話はいったん置いて|診断ではなく|恋愛相談ではなく|コードの話に戻ります|コードの修正)/.test(userText.trim());

  if (explicitContextReset) {
    console.log('[IROS/PRE_SEED/UNIVERSAL][CONTEXT_RESET]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      userTextHead: userText.slice(0, 120),
      reason: 'explicit_exit_to_normal',
    });

    return {
      kind: 'normal_chat',
      memoryIntent: 'normal_chat',
      memorySpace: 'normal',
      route: 'normal_writer',

      confidence: 0.95,

      resolvedTarget: null,
      resolvedRelation: null,

      sourceAuthority: 'user_text',
      sourceKind: 'context_reset',
      sourceId: null,
      sourceText: userText,

      seedText:
        'CONTEXT_RESET_SEED (DO NOT OUTPUT):\n' +
        'reason=explicit_exit_to_normal\n' +
        'rule=このターンは前の診断・関係・人物文脈を引き継がない。\n' +
        'rule=SimilarFlow / pastContext / relationship fallback を使わない。\n' +
        'rule=ユーザーの現在入力を起点に通常チャットとして返す。\n' +
        'currentUserText:\n' +
        userText,

      writerInput: null,

      directReply: null,

      shouldUsePreSeedWriter: false,
      shouldBypassNormalWriter: false,
      shouldBypassRephrase: false,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      shouldSuppressSlotPlan: false,
      shouldSuppressMemoryDelta: true,
      shouldSuppressNormalResonance: false,

      shouldOpenContextThread: false,
      contextThreadCode: null,

      ctxPackPatch: {
        contextReset: true,
        contextResetReason: 'explicit_exit_to_normal',
        shouldCloseContextThread: true,
        shouldResetActiveTarget: true,
        shouldSuppressPastContext: true,
        contextThread: null,
        activeTarget: null,
        pendingOffer: null,
        resolvedTarget: null,
        resolvedRelation: null,
      },

      metaPatch: {
        contextReset: true,
        contextResetReason: 'explicit_exit_to_normal',
        shouldCloseContextThread: true,
        shouldResetActiveTarget: true,
        shouldSuppressPastContext: true,
      },

      debug: {
        reason: 'explicit_exit_to_normal_context_reset',
        matchedPattern: 'detectExitToNormal',
        routeReason: 'context_reset_to_normal_writer',
      },
    };
  }

  const memoryIntent = classifyMemoryIntent(userText);

  if (memoryIntent === 'normal_chat' || memoryIntent === 'unknown') {
    return null;
  }

  const conversationScope = getUniversalConversationScopeFlags(args.meta);

  if (shouldSuppressUniversalMemoryIntentByScope(memoryIntent, conversationScope)) {
    console.log('[IROS/PRE_SEED/UNIVERSAL][SCOPE_SKIP]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      memoryIntent,
      reason: conversationScope.reason ?? 'memory_intent_disabled_by_conversation_scope',
      blockPastContext: conversationScope.blockPastContext,
    });
    return null;
  }

  const scopedHistoryForTurn = conversationScope.allowResolvedReferenceFromHistory
    ? (Array.isArray(args.historyForTurn) ? args.historyForTurn : [])
    : [];

  const ctxPack = args.meta?.extra?.ctxPack ?? args.meta?.ctxPack ?? null;

  const resolvedTarget = await resolveTargetForPreSeed({
    userText,
    historyForTurn: scopedHistoryForTurn,
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
    conversationScopeReason: conversationScope.reason,
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
