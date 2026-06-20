import { buildCognitionMap } from '../../cognition/buildCognitionMap';
import { cognitionMapToSeedText, type CognitionMap } from '../../cognition/cognitionMap';
import { buildIrDiagnosisPreSeed } from './buildIrDiagnosisPreSeed';
import { resolveUniversalPreSeed } from './universal';
import type { PreSeedDecision, ResolvePreSeedDecisionArgs } from './types';
import { detectPreSeedIntent } from './detectPreSeedIntent';
import { buildScreenshotDiagnosisPreSeed } from './buildScreenshotDiagnosisPreSeed';
import { buildPersonContextPreSeed } from './buildPersonContextPreSeed';

function normalizeLite(v: any): string {
  return String(v ?? '')
    .trim()
    .replace(/[ \t\r\n　]/g, '')
    .toLowerCase();
}

function getTurnText(t: any): string {
  return String(
    t?.content ??
      t?.text ??
      t?.assistantText ??
      t?.message ??
      t?.body ??
      ''
  ).trim();
}

function extractLatestScreenshotDisplayIdFromHistory(historyForTurn: any[]): number | null {
  const tail = Array.isArray(historyForTurn) ? historyForTurn.slice(-20).reverse() : [];

  for (const t of tail) {
    const s = getTurnText(t);
    if (!s) continue;

    const compact = s.replace(/[ \t\r\n　]/g, '');

    const m =
      compact.match(/スクショ診断ID[:：]?(\d+)/u) ??
      compact.match(/スクショ診断(\d+)/u) ??
      compact.match(/displayId[:：]?(\d+)/u);

    const n = m?.[1] ? Number.parseInt(m[1], 10) : NaN;

    if (Number.isFinite(n) && n > 0) {
      return n;
    }
  }
  return null;
}

function hasRecentScreenshotContext(historyForTurn: any[]): boolean {
  const tail = Array.isArray(historyForTurn) ? historyForTurn.slice(-6) : [];

  return tail.some((t: any) => {
    const s = getTurnText(t);
    const compact = s.replace(/[ \t\r\n　]/g, '');

    return (
      /スクショ診断ID[:：]?\d+/u.test(compact) ||
      /screenshot_diagnosis/u.test(compact) ||
      /SCREENSHOT_DIAGNOSIS_FOLLOWUP_SEED/u.test(s) ||
      /診断本文.*正本/u.test(s) ||
      /原因確認|自己責任|最近希望がない|約束守れなかった|そう言う事じゃない|すれ違いの継続/u.test(s)
    );
  });
}

function isExplicitScreenshotExit(userText: string): boolean {
  const text = String(userText ?? '').trim();

  if (!text) return false;

  return /^(別件|話変わる|話を変える|ところで|関係ない話|通常チャット|別の相談|違う話|それは置いといて|一旦戻って)/u.test(
    text
  );
}

function looksLikeClearlyNormalChat(userText: string): boolean {
  const text = String(userText ?? '').trim();

  if (!text) return false;

  // 挨拶・一般タスク・開発相談・画像/動画/コード系などは診断文脈から外す
  return (
    /^(おはよう|こんにちは|こんばんは|ありがとう|了解|OK|ok)$/iu.test(text) ||
    /(コード|PowerShell|typecheck|npm|エラー|実装|修正|ファイル|route\.ts|typescript|ビルド|デプロイ|Git|コミット)/iu.test(text) ||
    /(画像|動画|プロンプト|VEO|Seedance|Kling|花火|16:9|9:16)/iu.test(text) ||
    /(Moodle|PAY\.JP|Supabase|Firebase|Cloudflare|Zoho|ドメイン)/iu.test(text)
  );
}


function buildFastPathDirectReplyDecision(args: {
  userText: string;
  kind: 'greeting' | 'thanks' | 'ack' | 'closing';
  directReply: string;
}): PreSeedDecision {
  return {
    kind: 'normal_chat',
    confidence: 0.99,

    sourceAuthority: 'user_text',
    sourceKind: `fast_path_${args.kind}`,
    sourceId: null,
    sourceText: args.userText,

    route: 'direct_reply',

    seedText: null,
    directReply: args.directReply,
    writerInput: null,

    shouldBypassWriter: true,
    shouldBypassRephrase: true,
    shouldUsePreSeedWriter: false,

    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: true,
    shouldSuppressMemoryDelta: true,
    shouldSuppressIntuitionCandidate: true,
    shouldSuppressNormalResonance: true,

    shouldOpenContextThread: false,
    contextThreadCode: null,

    ctxPackPatch: {
      fastPath: true,
      fastPathKind: args.kind,
      inputKind: args.kind,
      shortSummary: args.userText,
      contextReset: true,
      contextResetReason: `fast_path_${args.kind}`,
      shouldCloseContextThread: true,
      shouldResetActiveTarget: true,
      shouldSuppressPastContext: true,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      historyForWriter: [],
      similarFlowSeed: '',
      similarFlowDebug: null,
      goalKind: 'stabilize',
      targetKind: 'stabilize',
      replyGoal: { kind: 'stabilize' },
      qCode: 'Q1',
      depthStage: 'S1',
      presentationKind: 'fast_path_direct_reply',
    },

    metaPatch: {
      fastPath: true,
      fastPathKind: args.kind,
      inputKind: args.kind,
      contextReset: true,
      contextResetReason: `fast_path_${args.kind}`,
      shouldCloseContextThread: true,
      shouldResetActiveTarget: true,
      shouldSuppressPastContext: true,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      goalKind: 'stabilize',
      targetKind: 'stabilize',
      q_code: 'Q1',
      depth_stage: 'S1',
      presentationKind: 'fast_path_direct_reply',
    },

    debug: {
      reason: `fast_path_${args.kind}`,
      matchedPattern: `fast_path_${args.kind}`,
      directReplyHead: args.directReply.slice(0, 120),
      sourceTextHead: args.userText.slice(0, 120),
    },
  };
}

function resolveFastPathDirectReply(userTextRaw: string): PreSeedDecision | null {
  const userText = String(userTextRaw ?? '').trim();
  const compact = userText.replace(/[ \t\r\n　]/g, '').toLowerCase();

  if (!compact) return null;

  if (/^(おはよう|おはようございます)$/u.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'greeting',
      directReply: 'おはようございます。',
    });
  }

  if (/^(こんにちは|こんにちわ)$/u.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'greeting',
      directReply: 'こんにちは。',
    });
  }

  if (/^(こんばんは|こんばんわ)$/u.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'greeting',
      directReply: 'こんばんは。',
    });
  }

  if (/^(ありがとう|ありがとうございます|ありがと)$/u.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'thanks',
      directReply: 'こちらこそ、ありがとうございます。',
    });
  }

  if (/^(了解|了解です|わかりました|分かりました|ok|ｏｋ)$/iu.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'ack',
      directReply: 'はい、了解です。',
    });
  }

  if (/^(またね|ではまた|おやすみ|おやすみなさい)$/u.test(compact)) {
    return buildFastPathDirectReplyDecision({
      userText,
      kind: 'closing',
      directReply: compact.startsWith('おやすみ') ? 'おやすみなさい。' : 'また話しましょう。',
    });
  }

  return null;
}

function attachCognitionMapToDecision(
  decision: PreSeedDecision,
  cognitionMap: CognitionMap,
): PreSeedDecision {
  const cognitionMapSeedText = cognitionMapToSeedText(cognitionMap);

  return {
    ...decision,
    ctxPackPatch: {
      ...(decision.ctxPackPatch ?? {}),
      cognitionMap,
      cognitionMapSeedText,
      cognitionMapApplied: true,
    },
    metaPatch: {
      ...(decision.metaPatch ?? {}),
      cognitionMap,
      cognitionMapSeedText,
      cognitionMapApplied: true,
    },
    debug: ({
      ...(decision.debug ?? {}),
      cognitionMapApplied: true,
      cognitionMapRelationCode: cognitionMap.relationCode,
      cognitionMapProgress: cognitionMap.progress,
      cognitionMapTriggerKind: cognitionMap.trigger.kind,
      cognitionMapGapState: cognitionMap.gap.state,
    } as any),
  };
}
function getScreenshotDiagnosisFollowupStrength(args: {
  userText: string;
  historyForTurn: any[];
}): 'strong' | 'weak' | 'none' | 'exit' {
  const userText = String(args.userText ?? '').trim();

  if (!userText) return 'none';

  if (isExplicitScreenshotExit(userText) || looksLikeClearlyNormalChat(userText)) {
    return 'exit';
  }

  const compact = normalizeLite(userText);
  const recentContext = hasRecentScreenshotContext(args.historyForTurn);

  const strongKeyPhraseHit = [
    'そう言う事じゃない',
    'そういう事じゃない',
    'そういうことじゃない',
    '最近希望がない',
    '約束守れなかった',
    '私が悪い',
    'すれ違い',
    'すれ違いの継続',
    '原因確認',
    '原因探し',
    '自己責任',
    '自己非難',
    '受け止め',
    '会えなかった',
    '9:16',
    '11:41',
  ].some((p) => compact.includes(normalizeLite(p)));

  if (strongKeyPhraseHit) return 'strong';

  const followupQuestionLike =
    /(どういう|どういう事|どういうこと|なぜ|なんで|つまり|もう少し|詳しく|それは|これは|この言葉|この部分|意味|気持ち|本音|意図|どう返す|返し方|相手は|相手に|私はどう|どうしたら)/u.test(
      userText
    );

  if (recentContext && followupQuestionLike) return 'weak';

  return 'none';
}

function buildAmbiguousScreenshotClarifyDecision(args: {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  traceId?: string | null;
  displayId: number;
}): PreSeedDecision {
  const directReply =
    `これはスクショ診断ID:${args.displayId}の続きとして見てもよさそうですが、通常の相談にも見えます。\n\n` +
    `このまま診断ID:${args.displayId}の続きとして見ますか？\n` +
    `それとも、別件として通常チャットで見ますか？`;

  return {
    kind: 'screenshot_diagnosis_followup',
    confidence: 0.45,
    sourceAuthority: 'screenshot_diagnosis_text',
    sourceKind: 'mu_screenshot_diagnosis_logs',
    sourceId: args.displayId,
    sourceText: null,
    route: 'clarify',
    seedText: null,
    directReply,
    shouldBypassWriter: true,
    shouldBypassRephrase: true,
    shouldUsePreSeedWriter: false,
    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: true,
    shouldSuppressMemoryDelta: true,
    shouldSuppressIntuitionCandidate: true,
    shouldSuppressNormalResonance: true,
    shouldOpenContextThread: false,
    contextThreadCode: null,
    ctxPackPatch: {
      contextMode: 'diagnosis_context_ambiguous',
      contextAuthority: 'screenshot_diagnosis',
      presentationKind: 'screenshot_diagnosis_ambiguous_followup',
      screenshotDiagnosisFollowupAmbiguous: true,
      question: {
        type: 'choose_context',
        displayId: args.displayId,
      },
    },
    metaPatch: {
      presentationKind: 'screenshot_diagnosis_ambiguous_followup',
      screenshotDiagnosisFollowupAmbiguous: true,
      contextMode: 'diagnosis_context_ambiguous',
      contextAuthority: 'screenshot_diagnosis',
    },
    debug: {
      reason: 'ambiguous_screenshot_diagnosis_followup',
      matchedPattern: 'ambiguous_history_screenshot_context',
      extractedId: args.displayId,
    },
  };
}

async function fetchLatestScreenshotDiagnosisForConversation(args: {
  supabase: any;
  userCode: string;
  conversationId?: string | null;
}): Promise<any | null> {
  const { supabase, userCode } = args;
  const conversationId = String(args.conversationId ?? '').trim();

  if (!supabase?.from || !userCode) return null;

  const select =
    'id, display_id, user_code, conversation_id, source, mode, diagnosis_text, diagnosis_seed_json, used_at, created_at';

  if (conversationId) {
    const byConversation = await supabase
      .from('mu_screenshot_diagnosis_logs')
      .select(select)
      .eq('user_code', userCode)
      .eq('conversation_id', conversationId)
      .not('diagnosis_text', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (byConversation?.data) return byConversation.data;

    if (byConversation?.error) {
      console.warn('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_FETCH_BY_CONV_FAILED]', {
        userCode,
        conversationId,
        error: byConversation.error?.message ?? byConversation.error,
      });
    }
  }

  const byUser = await supabase
    .from('mu_screenshot_diagnosis_logs')
    .select(select)
    .eq('user_code', userCode)
    .not('diagnosis_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byUser?.error) {
    console.warn('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_FETCH_BY_USER_FAILED]', {
      userCode,
      conversationId,
      error: byUser.error?.message ?? byUser.error,
    });
  }

  return byUser?.data ?? null;
}

export async function resolvePreSeedDecision(
  args: ResolvePreSeedDecisionArgs
): Promise<PreSeedDecision | null> {
  const detected = detectPreSeedIntent(args.userText);

  if (detected.kind === 'screenshot_diagnosis_boot') {
    return buildScreenshotDiagnosisPreSeed({
      ...args,
      displayId: detected.displayId,
      matchedPattern: detected.matchedPattern,
    });
  }

  const userText = String(args.userText ?? '').trim();

  const cognitionMap = buildCognitionMap({
    userText,
    sourceKind: 'preseed',
    sourceText: userText,
    debug: {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },
  });

  console.log('[IROS/PRE_SEED_ENGINE][COGNITION_MAP_BUILT]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode ?? null,
    relationCode: cognitionMap.relationCode,
    relationDomain: cognitionMap.relationDomain,
    progress: cognitionMap.progress,
    gapState: cognitionMap.gap.state,
    triggerKind: cognitionMap.trigger.kind,
    godai: cognitionMap.worldTags.godai,
    sanmitsu: cognitionMap.worldTags.sanmitsu,
    confidence: cognitionMap.confidence,
  });

  const fastPathDirectReply = resolveFastPathDirectReply(userText);
  if (fastPathDirectReply) {
    console.log('[IROS/PRE_SEED_ENGINE][FAST_PATH_DIRECT_REPLY]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      userTextHead: userText.slice(0, 120),
      fastPathKind: fastPathDirectReply.metaPatch?.fastPathKind ?? null,
      directReplyHead: String(fastPathDirectReply.directReply ?? '').slice(0, 120),
    });

    return attachCognitionMapToDecision(fastPathDirectReply, cognitionMap);
  }

  const isMemoryTruthCheck =
    (
      /(覚えて|覚えてる|覚えていますか|覚えてますか|前に話した|以前話した|前話した|この前話した|あの話|その話|続き|記憶にありますか)/u.test(userText) &&
      /(話|こと|件|覚えて|覚えてる|覚えていますか|覚えてますか|記憶)/u.test(userText)
    ) ||
    /[一-龯ぁ-んァ-ヶA-Za-z0-9_]{2,}(さん|様|くん|ちゃん)?(の)?(話|件|診断|記憶)?(は|って)?(ありますか|ある？|ある\?|残ってますか|残っていますか|記憶にありますか)/u.test(userText);

  if (isMemoryTruthCheck) {
    console.log('[IROS/PRE_SEED_ENGINE][MEMORY_TRUTH_CHECK_ENTER]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      userTextHead: userText.slice(0, 120),
      reason: 'explicit_memory_truth_check',
    });

    const memoryTruthSeedText = [
      'MEMORY_TRUTH_CHECK_SEED (DO NOT OUTPUT)',
      'source=preseed_memory_truth_check',
      'turnTask=memory_recall_check',
      'sourcePolicy=verified_memory_only',
      'rule=このターンは、ユーザーが過去記憶の有無を確認している。',
      'rule=SimilarFlow は記憶証拠ではないため使わない。',
      'rule=前のassistant発話も記憶証拠ではない。',
      'rule=verified memory がない限り、「覚えています」「前に話しました」と言わない。',
      'rule=実際の verified / none 判定は MEMORY_RECALL_PREFLIGHT に任せる。',
      'currentUserText=' + userText,
    ].join('\n');

    const memoryTruthTurnContract = {
      version: 'turn_contract_v1',
      turnTask: 'memory_recall_check',
      memoryStatus: 'preflight_required',
      actualIntent: 'Muに過去記憶があるか確認している',
      sourcePolicy: 'verified_memory_only',
      writerAction: 'wait_for_memory_recall_preflight',
      disable: {
        resonance: true,
        tcfRefocus: true,
        normalResonanceMaterialize: true,
        historyFalseRecall: true,
        flowMeaningExpansion: true,
        similarFlowAsMemory: true,
      },
      mustNotSay: [
        '覚えています',
        '覚えてるよ',
        '前に話しました',
        '以前の会話では',
      ],
      reason: 'PRE_SEED_MEMORY_TRUTH_CHECK',
    };

    return {
      kind: 'normal_chat',
      confidence: 0.98,

      sourceAuthority: 'user_text',
      sourceKind: 'memory_truth_check',
      sourceId: null,
      sourceText: userText,

      route: 'normal_writer',

      seedText: memoryTruthSeedText,
      directReply: null,
      writerInput: null,

      shouldBypassWriter: false,
      shouldBypassRephrase: false,
      shouldUsePreSeedWriter: false,

      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      shouldSuppressSlotPlan: false,
      shouldSuppressMemoryDelta: true,
      shouldSuppressIntuitionCandidate: true,
      shouldSuppressNormalResonance: true,

      shouldOpenContextThread: false,
      contextThreadCode: null,

      ctxPackPatch: {
        memoryTruthCheck: true,
        memoryRecallCheck: true,
        memoryCertainty: 'preflight_required',
        memoryCertaintyGuardApplied: true,
        turnContract: memoryTruthTurnContract,
        turnUnderstanding: memoryTruthTurnContract,
        memorySeedText: memoryTruthSeedText,
        memorySeedKind: 'memory_truth_check',
        shouldSuppressSimilarFlow: true,
        shouldSuppressHistoryForWriter: true,
        similarFlowSeed: '',
        similarFlowDebug: null,
      },

      metaPatch: {
        memoryTruthCheck: true,
        memoryRecallCheck: true,
        memoryCertainty: 'preflight_required',
        memoryCertaintyGuardApplied: true,
        turnContract: memoryTruthTurnContract,
        turnUnderstanding: memoryTruthTurnContract,
        shouldSuppressSimilarFlow: true,
        shouldSuppressHistoryForWriter: true,
      },

      debug: {
        reason: 'explicit_memory_truth_check',
        matchedPattern: 'memory_truth_check_regex',
        sourceTextHead: userText.slice(0, 120),
        seedHead: memoryTruthSeedText.slice(0, 160),
      },
    };
  }

  const historyForTurn = Array.isArray(args.historyForTurn)
    ? args.historyForTurn
    : [];

  const historyDisplayId = extractLatestScreenshotDisplayIdFromHistory(historyForTurn);
  const strength = getScreenshotDiagnosisFollowupStrength({
    userText,
    historyForTurn,
  });

  if (strength === 'exit') {
    console.log('[IROS/PRE_SEED_ENGINE][SCREENSHOT_CONTEXT_RESET]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      userTextHead: userText.slice(0, 120),
      reason: 'screenshot_context_exit_to_normal',
    });

    return {
      kind: 'normal_chat',
      route: 'normal_writer',

      confidence: 0.95,


      sourceAuthority: 'user_text',
      sourceKind: 'context_reset',
      sourceId: null,
      sourceText: userText,

      seedText:
        'CONTEXT_RESET_SEED (DO NOT OUTPUT):\n' +
        'reason=screenshot_context_exit_to_normal\n' +
        'rule=このターンは前のスクショ診断・IR診断・関係・人物文脈を引き継がない。\n' +
        'rule=SimilarFlow / pastContext / relationship fallback を使わない。\n' +
        'rule=ユーザーの現在入力を起点に通常チャットとして返す。\n' +
        'currentUserText:\n' +
        userText,

      writerInput: null,

      directReply: null,

      shouldUsePreSeedWriter: false,
      shouldBypassWriter: false,
      shouldBypassRephrase: false,
      shouldSuppressHistoryForWriter: true,
      shouldSuppressSimilarFlow: true,
      shouldSuppressSlotPlan: false,
      shouldSuppressMemoryDelta: true,
      shouldSuppressIntuitionCandidate: true,
      shouldSuppressNormalResonance: false,

      shouldOpenContextThread: false,
      contextThreadCode: null,

      ctxPackPatch: {
        contextReset: true,
        contextResetReason: 'screenshot_context_exit_to_normal',
        shouldCloseContextThread: true,
        shouldResetActiveTarget: true,
        shouldSuppressPastContext: true,
        shouldSuppressHistoryForWriter: true,
        shouldSuppressSimilarFlow: true,
        contextThread: null,
        activeTarget: null,
        pendingOffer: null,
        resolvedTarget: null,
        resolvedRelation: null,
        historyForWriter: [],
        similarFlowSeed: '',
        similarFlowDebug: null,
        relationship: null,
        relationshipMemory: null,
        relationshipMemoryNote: null,
        memorySeedText: null,
        memorySeedResult: null,
        memorySeedKind: null,
      },

      metaPatch: {
        contextReset: true,
        contextResetReason: 'screenshot_context_exit_to_normal',
        shouldCloseContextThread: true,
        shouldResetActiveTarget: true,
        shouldSuppressPastContext: true,
        shouldSuppressHistoryForWriter: true,
        shouldSuppressSimilarFlow: true,
      },

      debug: {
        reason: 'screenshot_context_exit_to_normal_context_reset',
        matchedPattern: 'getScreenshotDiagnosisFollowupStrength:exit',
      },
    };
  }

  if (historyDisplayId && strength === 'strong') {
    console.log('[IROS/PRE_SEED_ENGINE][HISTORY_SCREENSHOT_CONTEXT_CONTINUE]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: historyDisplayId,
      strength,
      userTextHead: userText.slice(0, 120),
    });

    return buildScreenshotDiagnosisPreSeed({
      ...args,
      displayId: historyDisplayId,
      matchedPattern: 'history_screenshot_diagnosis_context_followup_strong',
    });
  }

  if (historyDisplayId && strength === 'weak') {
    console.log('[IROS/PRE_SEED_ENGINE][HISTORY_SCREENSHOT_CONTEXT_AMBIGUOUS]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: historyDisplayId,
      strength,
      userTextHead: userText.slice(0, 120),
    });

    return buildAmbiguousScreenshotClarifyDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      displayId: historyDisplayId,
    });
  }

  const latest = await fetchLatestScreenshotDiagnosisForConversation({
    supabase: args.supabase,
    userCode: args.userCode,
    conversationId: args.conversationId,
  });

  const latestDisplayId = Number(latest?.display_id ?? 0);

  if (
    Number.isFinite(latestDisplayId) &&
    latestDisplayId > 0 &&
    strength === 'strong'
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_CONTEXT_CONTINUE]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: latestDisplayId,
      strength,
      userTextHead: userText.slice(0, 120),
      diagnosisTextLen: String(latest?.diagnosis_text ?? '').length,
    });

    return buildScreenshotDiagnosisPreSeed({
      ...args,
      displayId: latestDisplayId,
      matchedPattern: 'latest_screenshot_diagnosis_context_followup_strong',
    });
  }

  if (
    Number.isFinite(latestDisplayId) &&
    latestDisplayId > 0 &&
    strength === 'weak'
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_CONTEXT_AMBIGUOUS]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: latestDisplayId,
      strength,
      userTextHead: userText.slice(0, 120),
    });

    return buildAmbiguousScreenshotClarifyDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      displayId: latestDisplayId,
    });
  }
  try {
    const universalCandidate = await resolveUniversalPreSeed({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      supabase: args.supabase,
      meta: args.meta,
      historyForTurn: args.historyForTurn,
      traceId: args.traceId ?? null,
    });

    if (universalCandidate) {
      console.log('[IROS/PRE_SEED_ENGINE][UNIVERSAL_CANDIDATE_ONLY]', {
        traceId: args.traceId ?? null,
        conversationId: args.conversationId,
        userCode: args.userCode,
        kind: universalCandidate.kind,
        memoryIntent: universalCandidate.memoryIntent,
        memorySpace: universalCandidate.memorySpace,
        route: universalCandidate.route,
        sourceAuthority: universalCandidate.sourceAuthority,
        targetKey: universalCandidate.resolvedTarget?.targetKey ?? null,
        relationId: universalCandidate.resolvedRelation?.relationId ?? null,
        confidence: universalCandidate.confidence,
      });

      if (
        universalCandidate.memoryIntent === 'ir_diagnosis_recall' &&
        universalCandidate.resolvedTarget?.targetKey
      ) {
        const irDecision = await buildIrDiagnosisPreSeed({
          ...args,
          targetKey: universalCandidate.resolvedTarget.targetKey,
          targetLabel: universalCandidate.resolvedTarget.label,
          matchedPattern: 'universal_ir_diagnosis_recall',
        } as any);

        if (irDecision) {
          console.log('[IROS/PRE_SEED_ENGINE][IR_DIAGNOSIS_DECISION_RETURN]', {
            traceId: args.traceId ?? null,
            conversationId: args.conversationId,
            userCode: args.userCode,
            targetKey: universalCandidate.resolvedTarget.targetKey,
            targetLabel: universalCandidate.resolvedTarget.label,
            route: irDecision.route,
            sourceId: irDecision.sourceId ?? null,
            sourceTextLen: String((irDecision as any).sourceText ?? '').length,
            seedLen: String((irDecision as any).seedText ?? '').length,
          });

          return irDecision;
        }
      }
    }

      if (
        universalCandidate &&
        (
          universalCandidate.memoryIntent === 'person_state_recall' ||
          universalCandidate.memoryIntent === 'person_reference' ||
          universalCandidate.memoryIntent === 'relationship_recall'
        ) &&
        universalCandidate.resolvedTarget?.targetKey &&
        universalCandidate.resolvedTarget?.label
      ) {
        const personDecision = await buildPersonContextPreSeed({
          ...args,
          targetKey: universalCandidate.resolvedTarget.targetKey,
          targetLabel: universalCandidate.resolvedTarget.label,
          traceId: args.traceId ?? null,
        });

        if (personDecision) {
          console.log('[IROS/PRE_SEED_ENGINE][PERSON_CONTEXT_DECISION_RETURN]', {
            traceId: args.traceId ?? null,
            conversationId: args.conversationId,
            userCode: args.userCode,
            targetKey: universalCandidate.resolvedTarget.targetKey,
            targetLabel: universalCandidate.resolvedTarget.label,
            route: personDecision.route,
            sourceId: personDecision.sourceId ?? null,
            seedLen: String((personDecision as any).seedText ?? '').length,
          });

          return personDecision;
        }
      }
  } catch (e: any) {
    console.warn('[IROS/PRE_SEED_ENGINE][UNIVERSAL_CANDIDATE_FAILED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      error: e?.message ?? e,
    });
  }

  return null;
}




















