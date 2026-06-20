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

function buildAmbiguousDiagnosisKindClarifyDecision(args: {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  traceId?: string | null;
  irTargetLabel?: string | null;
  screenshotDisplayId?: number | null;
}): PreSeedDecision {
  const irLabel = String(args.irTargetLabel ?? 'ir診断').trim() || 'ir診断';
  const screenshotLabel =
    args.screenshotDisplayId && args.screenshotDisplayId > 0
      ? `スクショ診断ID:${args.screenshotDisplayId}`
      : 'スクショ診断';

  const directReply =
    `「診断の内容」は、どちらの続きとして見ますか？\n\n` +
    `1. ${irLabel}のir診断\n` +
    `2. ${screenshotLabel}\n\n` +
    `番号か、「ir診断」「スクショ診断」で指定してください。`;

  return {
    kind: 'diagnosis_context_clarify',
    confidence: 0.5,
    sourceAuthority: 'user_text',
    sourceKind: 'ambiguous_diagnosis_context',
    sourceId: args.screenshotDisplayId ?? null,
    sourceText: args.userText,
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
      contextAuthority: 'diagnosis_context',
      presentationKind: 'diagnosis_kind_clarify',
      diagnosisKindClarify: true,
      irTargetLabel: irLabel,
      screenshotDisplayId: args.screenshotDisplayId ?? null,
    },
    metaPatch: {
      presentationKind: 'diagnosis_kind_clarify',
      diagnosisKindClarify: true,
      contextMode: 'diagnosis_context_ambiguous',
      contextAuthority: 'diagnosis_context',
      irTargetLabel: irLabel,
      screenshotDisplayId: args.screenshotDisplayId ?? null,
    },
    debug: {
      reason: 'ambiguous_diagnosis_kind_has_ir_and_screenshot',
      matchedPattern: 'ambiguous_diagnosis_reference',
      irTargetLabel: irLabel,
      screenshotDisplayId: args.screenshotDisplayId ?? null,
    },
  } as any;
}
function hasRecentDiagnosisKindClarifyContext(historyForTurn: any[]): boolean {
  const tail = Array.isArray(historyForTurn) ? historyForTurn.slice(-8).reverse() : [];

  return tail.some((t: any) => {
    const s = getTurnText(t);
    if (!s) return false;

    return (
      /どちらの続きとして見ますか/u.test(s) &&
      /ir診断/u.test(s) &&
      /スクショ診断/u.test(s)
    );
  });
}

function resolveDiagnosisKindClarifySelection(args: {
  userText: string;
  historyForTurn?: any[];
}): 'ir' | 'screenshot' | null {
  if (!hasRecentDiagnosisKindClarifyContext(args.historyForTurn ?? [])) return null;

  const compact = String(args.userText ?? '')
    .trim()
    .replace(/[　\s]+/g, '')
    .toLowerCase();

  if (/^(1|１|一|ir|ｉｒ|ir診断|ｉｒ診断)$/u.test(compact)) return 'ir';

  if (/^(2|２|二|スクショ診断|スクリーンショット診断|画像診断|screenshot|screenshotdiagnosis)$/u.test(compact)) {
    return 'screenshot';
  }

  return null;
}
function isExplicitIrDiagnosisRequest(userTextRaw: string): boolean {
  const compact = String(userTextRaw ?? '')
    .trim()
    .replace(/[　\s]+/g, '')
    .toLowerCase();

  return /^(ir|ｉｒ)診断/u.test(compact);
}

function isExplicitScreenshotDiagnosisRequest(userTextRaw: string): boolean {
  const compact = String(userTextRaw ?? '')
    .trim()
    .replace(/[　\s]+/g, '')
    .toLowerCase();

  return /(スクショ診断|スクリーンショット診断|画像診断|screenshotdiagnosis)/u.test(compact);
}

function extractExplicitPersonFollowupTarget(userTextRaw: string): {
  targetKey: string;
  targetLabel: string;
} | null {
  const text = String(userTextRaw ?? '').trim();
  if (!text) return null;

  if (/(スクショ|スクリーンショット|画像診断|ir診断|診断ID|診断結果|この診断|その診断)/u.test(text)) {
    return null;
  }

  const patterns: RegExp[] = [
    /^(.+?)(?:について|のこと|との関係|との距離|の状態|の気持ち|の本音|をもう少し|を深めて|を見て)/u,
    /^(.+?)(?:さん|様|ちゃん|くん)?(?:について|のこと|との関係|の状態|の気持ち|を見て|を深めて)/u,
  ];

  for (const pattern of patterns) {
    const m = text.match(pattern);
    const raw = String(m?.[1] ?? '').trim();
    if (!raw) continue;

    const label = raw
      .replace(/^(この|その|あの|さっきの|前の|直前の)/u, '')
      .replace(/[「」『』"'“”]/g, '')
      .trim();

    if (!label) continue;
    if (label.length > 24) continue;
    if (/(スクショ|スクリーンショット|診断|結果|内容|相手|自分|あなた|僕|私|これ|それ)/u.test(label)) continue;

    return {
      targetKey: label,
      targetLabel: label,
    };
  }

  return null;
}
function isDeicticDiagnosisOrRelationFollowup(userTextRaw: string): boolean {
  const text = String(userTextRaw ?? '').trim();
  if (!text) return false;

  // 明示指定は既存の診断ルートへ渡す
  if (isExplicitIrDiagnosisRequest(text) || isExplicitScreenshotDiagnosisRequest(text)) {
    return false;
  }

  // 明示人物名がある場合は existing explicit person route に任せる
  if (extractExplicitPersonFollowupTarget(text)) {
    return false;
  }

  const compact = text.replace(/[　\s]+/g, '');

  return (
    /(この|その|さっきの|前の|直前の)(診断|診断結果|結果|内容|返答|話|続き)/u.test(compact) ||
    /(診断|診断結果|結果).*(もう少し|深め|詳しく|気持ち|本音|意図|約束|来る|来ます|来ると思)/u.test(compact) ||
    /(相手|あの人|その人).*(気持ち|本音|意図|約束|来る|来ます|来ると思|どう思|どう動)/u.test(compact) ||
    /(約束).*(来る|来ます|来ると思|守る|守れそう)/u.test(compact)
  );
}

function isUnsafeImplicitTargetLabel(targetRaw: unknown): boolean {
  const target = String(targetRaw ?? '').trim();
  if (!target) return true;
  if (target.length > 24) return true;

  // 人物名ではなく、文中の意味句・判断句を targetKey にしてしまう事故を止める
  if (
    /(ただの|好意|気持ち|本音|意図|可能性|様子|慎重|関係|診断|結果|内容|約束|来る|来ます|思います|思って|よりも|けれど|だけど|だから|について|から|では|相手|あなた|自分|僕|私|これ|それ|この|その)/u.test(target)
  ) {
    return true;
  }

  return false;
}

function extractLatestPersonReferenceFromHistory(historyForTurnRaw: any[]): {
  targetKey: string;
  targetLabel: string;
  sourceUserText: string;
} | null {
  const history = Array.isArray(historyForTurnRaw) ? historyForTurnRaw : [];
  const tail = history.slice(-12).reverse();

  for (const message of tail) {
    const role = String(message?.role ?? message?.speaker ?? '').toLowerCase();
    const content = getTurnText(message);
    if (!content) continue;

    // 直近に明確なスクショ/ir診断がある場合は、人物復元より診断ルートを優先する
    if (
      role === 'assistant' &&
      /(SCREENSHOT_CONTEXT_V1|screenshotDiagnosisContext|screenshot_diagnosis|mu_screenshot_diagnosis|観測対象[:：]|IR_DIAGNOSIS|ir_diagnosis|diagnosisFollowup)/u.test(content)
    ) {
      return null;
    }

    if (role && role !== 'user') continue;

    const explicit = extractExplicitPersonFollowupTarget(content);
    if (!explicit?.targetKey || !explicit?.targetLabel) continue;

    if (isUnsafeImplicitTargetLabel(explicit.targetKey)) continue;

    return {
      targetKey: explicit.targetKey,
      targetLabel: explicit.targetLabel,
      sourceUserText: content,
    };
  }

  return null;
}
function hasDiagnosisReference(userTextRaw: string): boolean {
  const userText = String(userTextRaw ?? '').trim();
  if (!userText) return false;

  return (
    /(診断|結果|さっきの|この|それ|もう少し|深めて|見て|続きを|続き)/u.test(userText) &&
    /(診断|結果|さっき|この|それ|もう少し|深め|見て|続き)/u.test(userText)
  );
}

function resolveDiagnosisContextKind(args: {
  userText: string;
  meta?: any;
  historyForTurn?: any[];
}): 'screenshot' | 'ir' | 'ambiguous' | 'none' {
  const userText = String(args.userText ?? '').trim();
  if (isExplicitIrDiagnosisRequest(userText)) return 'ir';
  if (isExplicitScreenshotDiagnosisRequest(userText)) return 'screenshot';
  if (!hasDiagnosisReference(userText)) return 'none';

  const meta = args.meta ?? {};
  const ctxPack = meta?.ctxPack ?? meta?.extra?.ctxPack ?? {};

  const hasScreenshotContext = Boolean(
    meta?.screenshotDiagnosisContext ||
    meta?.screenshotDiagnosisHintText ||
    ctxPack?.screenshotDiagnosisContext ||
    ctxPack?.screenshotDiagnosisHintText ||
    ctxPack?.resolvedAsk?.referenceTarget?.includes?.('SCREENSHOT_CONTEXT_V1')
  );

  const hasIrContext = Boolean(
    meta?.lastIrDiagnosis ||
    ctxPack?.lastIrDiagnosis ||
    ctxPack?.diagnosisFollowup ||
    meta?.diagnosisFollowup
  );

  if (hasScreenshotContext && !hasIrContext) return 'screenshot';
  if (hasIrContext && !hasScreenshotContext) return 'ir';

  if (hasScreenshotContext && hasIrContext) {
    const lastIrDiagnosisLike =
      meta?.lastIrDiagnosis ??
      ctxPack?.lastIrDiagnosis ??
      null;

    const lastIrDiagnosisKindText = String(
      lastIrDiagnosisLike?.kind ??
        lastIrDiagnosisLike?.source ??
        lastIrDiagnosisLike?.targetLabel ??
        lastIrDiagnosisLike?.diagnosisFollowupTargetLabel ??
        ''
    );

    if (/screenshot|スクショ|スクリーンショット|mu_first_screenshot|screenshot_diagnosis/u.test(lastIrDiagnosisKindText)) {
      return 'screenshot';
    }

    const history = Array.isArray(args.historyForTurn) ? args.historyForTurn : [];
    const tail = history.slice(-6).map((m: any) => JSON.stringify(m ?? '')).join('\n');

    if (/SCREENSHOT_CONTEXT_V1|screenshotDiagnosisContext|screenshot_diagnosis|mu_screenshot_diagnosis/u.test(tail)) {
      return 'screenshot';
    }

    if (/lastIrDiagnosis|ir_diagnosis|diagnosisFollowup/u.test(tail)) {
      return 'ir';
    }

    return 'ambiguous';
  }

  return 'ambiguous';
}
function isScreenshotLikeDiagnosisCandidate(candidate: any): boolean {
  const raw = JSON.stringify(candidate ?? '').toLowerCase();

  return (
    raw.includes('screenshot') ||
    raw.includes('スクショ') ||
    raw.includes('スクリーンショット') ||
    raw.includes('mu_first_screenshot') ||
    raw.includes('screenshot_diagnosis')
  );
}

function extractLatestIrDiagnosisFromHistory(historyForTurnRaw: any[]): {
  targetKey: string;
  targetLabel: string;
  diagnosisText: string;
} | null {
  const history = Array.isArray(historyForTurnRaw) ? historyForTurnRaw : [];
  const tail = history.slice(-10).reverse();

  for (const message of tail) {
    const role = String(message?.role ?? message?.speaker ?? '').toLowerCase();
    const content = String(
      message?.content ??
        message?.text ??
        message?.body ??
        message?.message ??
        ''
    ).trim();

    if (!content) continue;
    if (role && role !== 'assistant') continue;

    const looksIrDiagnosis =
      /観測対象[:：]/u.test(content) &&
      /現状[:：]/u.test(content) &&
      /(ポイント|意識の向かう先|メッセージ)[:：]/u.test(content);

    if (!looksIrDiagnosis) continue;

    const targetMatch = content.match(/観測対象[:：]\s*([^\n\r]+)/u);
    let targetLabel = String(targetMatch?.[1] ?? 'ir診断').trim();

    // 「観測対象：みゆ 🧭 現状：...」のように同一行へ続く場合は、
    // 対象名だけを正規化して meta の汚れを防ぐ。
    targetLabel = targetLabel
      .replace(/\s*[🧭🧩🌱].*$/u, '')
      .replace(/\s*(現状|ポイント|メッセージ)[:：].*$/u, '')
      .trim();

    if (!targetLabel) targetLabel = 'ir診断';

    return {
      targetKey: targetLabel,
      targetLabel,
      diagnosisText: content,
    };
  }

  for (const message of tail) {
    const role = String(message?.role ?? message?.speaker ?? '').toLowerCase();
    const content = String(
      message?.content ??
        message?.text ??
        message?.body ??
        message?.message ??
        ''
    ).trim();

    if (!content) continue;
    if (role && role !== 'user') continue;

    const m = content.match(/^(?:ir|ｉｒ)診断[　\s]+(.+)$/iu);
    if (!m?.[1]) continue;

    const targetLabel = String(m[1]).trim();

    return {
      targetKey: targetLabel,
      targetLabel,
      diagnosisText: '',
    };
  }

  return null;
}

function buildHistoryIrDiagnosisFollowupDecision(args: {
  userText: string;
  userCode: string;
  conversationId?: string | null;
  traceId?: string | null;
  historyIr: {
    targetKey: string;
    targetLabel: string;
    diagnosisText: string;
  };
}): PreSeedDecision {
  const seedText = [
    'IR_DIAGNOSIS_FOLLOWUP_SEED (DO NOT OUTPUT)',
    'source=history_ir_diagnosis',
    `targetLabel=${args.historyIr.targetLabel}`,
    `targetKey=${args.historyIr.targetKey}`,
    'rule=このターンは直前のir診断結果の続き相談。',
    'rule=スクショ診断として扱わない。',
    'rule=新しい診断を作り直さず、下のir診断本文を正本として深める。',
    'rule=SimilarFlowや通常履歴に引っ張られない。',
    'rule=診断本文を引用して説明しない。',
    'rule=「ここで言う」「診断本文では」「補足すると」から始めない。',
    'rule=自然な追加解説として、観測対象の状態・揺れ・向かう先・ユーザーが見るべき点の順に深める。',
    'rule=返答冒頭は、対象の状態を一文で言い切る。',
    '',
    'USER_FOLLOWUP:',
    args.userText,
    '',
    'IR_DIAGNOSIS_TEXT:',
    args.historyIr.diagnosisText,
  ].join('\n');

  return {
    kind: 'ir_diagnosis_followup',
    confidence: 0.9,
    sourceAuthority: 'ir_diagnosis_text',
    sourceKind: 'history_ir_diagnosis',
    sourceId: null,
    sourceText: args.historyIr.diagnosisText,
    route: 'diagnosis_writer',
    seedText,
    directReply: null,
    writerInput: {
      writerKind: 'diagnosis_writer',
      displayId: 0,
      userText: args.userText,
      sourceText: args.historyIr.diagnosisText,
      seedText,
    },
    shouldBypassWriter: false,
    shouldBypassRephrase: false,
    shouldUsePreSeedWriter: true,
    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: false,
    shouldSuppressMemoryDelta: true,
    shouldSuppressIntuitionCandidate: true,
    shouldSuppressNormalResonance: true,
    shouldOpenContextThread: false,
    contextThreadCode: null,
    ctxPackPatch: {
      preSeedIrDiagnosis: true,
      diagnosisFollowup: true,
      presentationKind: 'diagnosis_followup',
      memoryIntent: 'ir_diagnosis_followup',
      memorySpace: 'ir_diagnosis',
      memoryTargetLabel: args.historyIr.targetLabel,
      memoryTargetKey: args.historyIr.targetKey,
      lastIrDiagnosis: {
        kind: 'ir_diagnosis',
        source: 'history_ir_diagnosis',
        targetKey: args.historyIr.targetKey,
        targetLabel: args.historyIr.targetLabel,
        diagnosisText: args.historyIr.diagnosisText,
      },
      shouldSuppressSimilarFlow: true,
      shouldSuppressHistoryForWriter: true,
    },
    metaPatch: {
      preSeedIrDiagnosis: true,
      diagnosisFollowup: true,
      presentationKind: 'diagnosis_followup',
      memoryIntent: 'ir_diagnosis_followup',
      memorySpace: 'ir_diagnosis',
      sourceAuthority: 'ir_diagnosis_text',
      targetKey: args.historyIr.targetKey,
      targetLabel: args.historyIr.targetLabel,
      lastIrDiagnosis: {
        kind: 'ir_diagnosis',
        source: 'history_ir_diagnosis',
        targetKey: args.historyIr.targetKey,
        targetLabel: args.historyIr.targetLabel,
        diagnosisText: args.historyIr.diagnosisText,
      },
      shouldSuppressSimilarFlow: true,
      shouldSuppressHistoryForWriter: true,
    },
    debug: {
      reason: 'history_ir_diagnosis_followup',
      matchedPattern: 'latest_assistant_ir_diagnosis_format',
      targetKey: args.historyIr.targetKey,
      targetLabel: args.historyIr.targetLabel,
    },
  } as any;
}
function pickActiveIrDiagnosisContext(metaRaw: any): {
  targetKey: string;
  targetLabel: string | null;
  source: any;
} | null {
  const meta = metaRaw ?? {};
  const ctxPack = meta?.ctxPack ?? meta?.extra?.ctxPack ?? {};

  const candidates = [
    ctxPack?.lastIrDiagnosis,
    meta?.lastIrDiagnosis,
    ctxPack?.activeIrDiagnosis,
    meta?.activeIrDiagnosis,
    ctxPack?.diagnosisFollowup,
    meta?.diagnosisFollowup,
    ctxPack?.irMeta,
    meta?.irMeta,
    ctxPack?.activeContextFrame,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isScreenshotLikeDiagnosisCandidate(candidate)) continue;

    const targetKey = String(
      candidate?.targetKey ??
        candidate?.target_key ??
        candidate?.structuredTargetKey ??
        candidate?.memoryTargetKey ??
        candidate?.person ??
        candidate?.target ??
        candidate?.label ??
        ''
    ).trim();

    const targetLabelRaw = String(
      candidate?.targetLabel ??
        candidate?.target_label ??
        candidate?.memoryTargetLabel ??
        candidate?.displayName ??
        candidate?.label ??
        targetKey
    ).trim();

    const hasDiagnosisText = Boolean(
      candidate?.diagnosisText ||
        candidate?.diagnosis_text ||
        candidate?.sourceText ||
        candidate?.text ||
        candidate?.summary ||
        candidate?.observation ||
        candidate?.state
    );

    if (targetKey && hasDiagnosisText) {
      return {
        targetKey,
        targetLabel: targetLabelRaw || targetKey,
        source: candidate,
      };
    }
  }

  return null;
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

  const withCognitionMap = (decision: PreSeedDecision | null): PreSeedDecision | null => {
    if (!decision) return null;
    return attachCognitionMapToDecision(decision, cognitionMap);
  };

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

    return withCognitionMap(fastPathDirectReply);
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

  const diagnosisContextKind = resolveDiagnosisContextKind({
    userText,
    meta: args.meta,
    historyForTurn,
  });

  console.log('[IROS/PRE_SEED_ENGINE][DIAGNOSIS_CONTEXT_KIND]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId ?? null,
    userCode: args.userCode ?? null,
    diagnosisContextKind,
    strength,
    userTextHead: userText.slice(0, 120),
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

  if (historyDisplayId && (strength === 'strong' || diagnosisContextKind === 'screenshot')) {
    console.log('[IROS/PRE_SEED_ENGINE][HISTORY_SCREENSHOT_CONTEXT_CONTINUE]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: historyDisplayId,
      strength,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap(await buildScreenshotDiagnosisPreSeed({
      ...args,
      displayId: historyDisplayId,
      matchedPattern: 'history_screenshot_diagnosis_context_followup_strong',
    }));
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

    return withCognitionMap(buildAmbiguousScreenshotClarifyDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      displayId: historyDisplayId,
    }));
  }

  const recentPersonReferenceForDeicticFollowup = extractLatestPersonReferenceFromHistory(historyForTurn);

  if (
    recentPersonReferenceForDeicticFollowup &&
    isDeicticDiagnosisOrRelationFollowup(userText)
  ) {
    const personDecision = await buildPersonContextPreSeed({
      ...args,
      targetKey: recentPersonReferenceForDeicticFollowup.targetKey,
      targetLabel: recentPersonReferenceForDeicticFollowup.targetLabel,
      traceId: args.traceId ?? null,
    });

    if (personDecision) {
      const enhancedPersonDecision: PreSeedDecision = {
        ...personDecision,
        confidence: Math.max(Number(personDecision.confidence ?? 0), 0.88),
        shouldBypassRephrase: true,
        shouldSuppressHistoryForWriter: true,
        shouldSuppressSimilarFlow: true,
        shouldSuppressMemoryDelta: true,
        shouldSuppressIntuitionCandidate: true,
        shouldSuppressNormalResonance: true,
        ctxPackPatch: {
          ...(personDecision.ctxPackPatch ?? {}),
          presentationKind: 'person_reference_followup',
          memoryIntent: 'person_reference',
          memorySpace: 'person',
          recentPersonReferenceResolved: true,
          recentPersonReferenceSourceUserText: recentPersonReferenceForDeicticFollowup.sourceUserText,
          shouldSuppressHistoryForWriter: true,
          shouldSuppressSimilarFlow: true,
          similarFlowSeed: '',
          similarFlowDebug: null,
          resolvedTarget: {
            ...((personDecision.ctxPackPatch as any)?.resolvedTarget ?? {}),
            status: 'resolved',
            label: recentPersonReferenceForDeicticFollowup.targetLabel,
            targetKey: recentPersonReferenceForDeicticFollowup.targetKey,
            canonicalName: recentPersonReferenceForDeicticFollowup.targetLabel,
            domain: 'person',
            confidence: 0.9,
            source: 'recent_explicit_person_reference',
          },
        },
        metaPatch: {
          ...(personDecision.metaPatch ?? {}),
          presentationKind: 'person_reference_followup',
          memoryIntent: 'person_reference',
          memorySpace: 'person',
          recentPersonReferenceResolved: true,
          recentPersonReferenceSourceUserText: recentPersonReferenceForDeicticFollowup.sourceUserText,
          targetKey: recentPersonReferenceForDeicticFollowup.targetKey,
          targetLabel: recentPersonReferenceForDeicticFollowup.targetLabel,
          shouldSuppressHistoryForWriter: true,
          shouldSuppressSimilarFlow: true,
        },
        debug: {
          ...(personDecision.debug ?? {}),
          reason: 'deictic_followup_recent_person_reference',
          matchedPattern: 'deictic_diagnosis_or_relation_followup_to_recent_person',
        },
      };

      console.log('[IROS/PRE_SEED_ENGINE][DEICTIC_PERSON_REFERENCE_CONTINUE]', {
        traceId: args.traceId ?? null,
        conversationId: args.conversationId ?? null,
        userCode: args.userCode,
        targetKey: recentPersonReferenceForDeicticFollowup.targetKey,
        targetLabel: recentPersonReferenceForDeicticFollowup.targetLabel,
        sourceUserTextHead: recentPersonReferenceForDeicticFollowup.sourceUserText.slice(0, 120),
        userTextHead: userText.slice(0, 120),
        route: enhancedPersonDecision.route,
      });

      return withCognitionMap(enhancedPersonDecision);
    }

    console.warn('[IROS/PRE_SEED_ENGINE][DEICTIC_PERSON_REFERENCE_SOURCE_NOT_FOUND]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      targetKey: recentPersonReferenceForDeicticFollowup.targetKey,
      targetLabel: recentPersonReferenceForDeicticFollowup.targetLabel,
      userTextHead: userText.slice(0, 120),
    });
  }
  const latest = await fetchLatestScreenshotDiagnosisForConversation({
    supabase: args.supabase,
    userCode: args.userCode,
    conversationId: args.conversationId,
  });

  const latestDisplayId = Number(latest?.display_id ?? 0);
  const hasLatestScreenshotDiagnosis =
    Number.isFinite(latestDisplayId) &&
    latestDisplayId > 0 &&
    Boolean(latest?.diagnosis_text);
  const historyIrDiagnosis = extractLatestIrDiagnosisFromHistory(historyForTurn);
  const diagnosisKindClarifySelection = resolveDiagnosisKindClarifySelection({
    userText,
    historyForTurn,
  });

  if (diagnosisKindClarifySelection === 'screenshot') {
    const selectedDisplayId =
      historyDisplayId ||
      (Number.isFinite(latestDisplayId) && latestDisplayId > 0 ? latestDisplayId : null);

    if (selectedDisplayId) {
      console.log('[IROS/PRE_SEED_ENGINE][DIAGNOSIS_KIND_SELECTION_SCREENSHOT]', {
        traceId: args.traceId ?? null,
        conversationId: args.conversationId ?? null,
        userCode: args.userCode,
        displayId: selectedDisplayId,
        userTextHead: userText.slice(0, 120),
      });

      return withCognitionMap(await buildScreenshotDiagnosisPreSeed({
        ...args,
        userText: 'スクショ診断の続きを詳しくしてください',
        displayId: selectedDisplayId,
        matchedPattern: 'diagnosis_kind_clarify_selection_screenshot',
      }));
    }
  }

  if (
    diagnosisKindClarifySelection === 'ir' &&
    historyIrDiagnosis?.diagnosisText
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][DIAGNOSIS_KIND_SELECTION_IR]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      targetKey: historyIrDiagnosis.targetKey,
      targetLabel: historyIrDiagnosis.targetLabel,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap(buildHistoryIrDiagnosisFollowupDecision({
      userText: 'ir診断の内容を深めてください',
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      historyIr: historyIrDiagnosis,
    }));
  }

  if (
    diagnosisContextKind === 'ambiguous' &&
    historyIrDiagnosis?.diagnosisText &&
    hasLatestScreenshotDiagnosis
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][DIAGNOSIS_KIND_CLARIFY]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      irTargetLabel: historyIrDiagnosis.targetLabel,
      screenshotDisplayId: latestDisplayId,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap(buildAmbiguousDiagnosisKindClarifyDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      irTargetLabel: historyIrDiagnosis.targetLabel,
      screenshotDisplayId: latestDisplayId,
    }));
  }
  if (
    historyIrDiagnosis?.diagnosisText &&
    (diagnosisContextKind === 'ir' || diagnosisContextKind === 'ambiguous')
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][HISTORY_IR_DIAGNOSIS_CONTEXT_CONTINUE]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode,
      targetKey: historyIrDiagnosis.targetKey,
      targetLabel: historyIrDiagnosis.targetLabel,
      sourceTextLen: String(historyIrDiagnosis.diagnosisText ?? '').length,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap(buildHistoryIrDiagnosisFollowupDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      historyIr: historyIrDiagnosis,
    }));
  }
  if (diagnosisContextKind === 'ir') {
    const activeIr = pickActiveIrDiagnosisContext(args.meta);

    if (activeIr?.targetKey) {
      const irDecision = await buildIrDiagnosisPreSeed({
        ...args,
        targetKey: activeIr.targetKey,
        targetLabel: activeIr.targetLabel,
        matchedPattern: 'active_ir_diagnosis_context_followup',
      } as any);

      if (irDecision) {
        console.log('[IROS/PRE_SEED_ENGINE][ACTIVE_IR_DIAGNOSIS_CONTEXT_CONTINUE]', {
          traceId: args.traceId ?? null,
          conversationId: args.conversationId ?? null,
          userCode: args.userCode,
          targetKey: activeIr.targetKey,
          targetLabel: activeIr.targetLabel,
          route: irDecision.route,
          sourceId: irDecision.sourceId ?? null,
          sourceTextLen: String((irDecision as any).sourceText ?? '').length,
        });

        return withCognitionMap(irDecision);
      }

      console.warn('[IROS/PRE_SEED_ENGINE][ACTIVE_IR_DIAGNOSIS_CONTEXT_SOURCE_NOT_FOUND]', {
        traceId: args.traceId ?? null,
        conversationId: args.conversationId ?? null,
        userCode: args.userCode,
        targetKey: activeIr.targetKey,
        targetLabel: activeIr.targetLabel,
        userTextHead: userText.slice(0, 120),
      });
    } else {
      console.warn('[IROS/PRE_SEED_ENGINE][ACTIVE_IR_DIAGNOSIS_CONTEXT_TARGET_NOT_FOUND]', {
        traceId: args.traceId ?? null,
        conversationId: args.conversationId ?? null,
        userCode: args.userCode,
        userTextHead: userText.slice(0, 120),
      });
    }
  }
  const latestForScreenshotRoute = await fetchLatestScreenshotDiagnosisForConversation({
    supabase: args.supabase,
    userCode: args.userCode,
    conversationId: args.conversationId,
  });

  const latestDisplayIdForScreenshotRoute = Number(latestForScreenshotRoute?.display_id ?? 0);

  if (
    Number.isFinite(latestDisplayIdForScreenshotRoute) &&
    latestDisplayIdForScreenshotRoute > 0 &&
    (strength === 'strong' || diagnosisContextKind === 'screenshot')
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_CONTEXT_CONTINUE]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: latestDisplayIdForScreenshotRoute,
      strength,
      userTextHead: userText.slice(0, 120),
      diagnosisTextLen: String(latestForScreenshotRoute?.diagnosis_text ?? '').length,
    });

    return withCognitionMap(await buildScreenshotDiagnosisPreSeed({
      ...args,
      displayId: latestDisplayIdForScreenshotRoute,
      matchedPattern: 'latest_screenshot_diagnosis_context_followup_strong',
    }));
  }

  if (
    Number.isFinite(latestDisplayIdForScreenshotRoute) &&
    latestDisplayIdForScreenshotRoute > 0 &&
    strength === 'weak'
  ) {
    console.log('[IROS/PRE_SEED_ENGINE][LATEST_SCREENSHOT_CONTEXT_AMBIGUOUS]', {
      traceId: args.traceId,
      conversationId: args.conversationId,
      userCode: args.userCode,
      displayId: latestDisplayIdForScreenshotRoute,
      strength,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap(buildAmbiguousScreenshotClarifyDecision({
      userText,
      userCode: args.userCode,
      conversationId: args.conversationId,
      traceId: args.traceId,
      displayId: latestDisplayIdForScreenshotRoute,
    }));
  }
  if (!historyDisplayId && diagnosisContextKind === 'ambiguous') {
    console.log('[IROS/PRE_SEED_ENGINE][DIAGNOSIS_CONTEXT_AMBIGUOUS]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      userTextHead: userText.slice(0, 120),
    });

    return withCognitionMap({
      kind: 'normal_chat',
      confidence: 0.55,
      sourceAuthority: 'user_text',
      sourceKind: 'diagnosis_context_ambiguous',
      sourceId: null,
      sourceText: userText,
      route: 'direct_reply',
      seedText: null,
      directReply: 'スクショ診断の続きとして見ますか？それとも、ir診断の続きを見ますか？',
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
        presentationKind: 'diagnosis_context_clarification',
        replyGoal: { kind: 'clarify' },
        qCode: 'Q1',
        depthStage: 'S1',
      },
      metaPatch: {
        presentationKind: 'diagnosis_context_clarification',
        diagnosisContextAmbiguous: true,
        inputKind: 'diagnosis_reference',
        goalKind: 'clarify',
        q_code: 'Q1',
        depth_stage: 'S1',
      },
      debug: {
        reason: 'diagnosis_context_ambiguous',
        matchedPattern: 'diagnosis_reference_without_context',
      },
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

      
      const explicitPersonFollowupTarget = extractExplicitPersonFollowupTarget(userText);


      if (
        universalCandidate?.resolvedTarget?.targetKey &&
        isUnsafeImplicitTargetLabel(universalCandidate.resolvedTarget.targetKey)
      ) {
        console.warn('[IROS/PRE_SEED_ENGINE][UNSAFE_UNIVERSAL_TARGET_DROPPED]', {
          traceId: args.traceId ?? null,
          conversationId: args.conversationId,
          userCode: args.userCode,
          memoryIntent: universalCandidate.memoryIntent,
          droppedTargetKey: universalCandidate.resolvedTarget.targetKey,
          droppedTargetLabel: universalCandidate.resolvedTarget.label ?? null,
          userTextHead: userText.slice(0, 120),
        });

        (universalCandidate as any).resolvedTarget = null;
      }
      if (
        universalCandidate?.memoryIntent === 'active_thread_followup' &&
        explicitPersonFollowupTarget?.targetKey &&
        explicitPersonFollowupTarget?.targetLabel
      ) {
        const personDecision = await buildPersonContextPreSeed({
          ...args,
          targetKey: explicitPersonFollowupTarget.targetKey,
          targetLabel: explicitPersonFollowupTarget.targetLabel,
          traceId: args.traceId ?? null,
        });

        if (personDecision) {
          console.log('[IROS/PRE_SEED_ENGINE][ACTIVE_THREAD_PERSON_REFERENCE_PROMOTED]', {
            traceId: args.traceId ?? null,
            conversationId: args.conversationId,
            userCode: args.userCode,
            fromMemoryIntent: universalCandidate.memoryIntent,
            targetKey: explicitPersonFollowupTarget.targetKey,
            targetLabel: explicitPersonFollowupTarget.targetLabel,
            route: personDecision.route,
            sourceId: personDecision.sourceId ?? null,
            seedLen: String((personDecision as any).seedText ?? '').length,
          });

          return withCognitionMap(personDecision);
        }
      }
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

          return withCognitionMap(irDecision);
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

          return withCognitionMap(personDecision);
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
























