import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

export type PreSeedAssistKind =
  | 'diagnosis_target_confirm'
  | 'diagnosis_followup'
  | 'relationship_target_confirm'
  | 'relationship_followup'
  | 'previous_event_confirm'
  | 'normal';

export type PreSeedAssistResult = {
  version: 'pre_seed_assist_v1';
  kind: PreSeedAssistKind;
  confidence: number;
  targetLabel: string | null;
  targetKey: string | null;
  directReply: string | null;
  seedText: string;
  shouldBypassWriter: boolean;
  reason: string;
};

export type RunPreSeedAssistArgs = {
  userText: string;
  ctxPack?: any;
  activeContextFrame?: any;
  lastIrDiagnosis?: any;
  historyForWriter?: any[];
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

const PRESEED_MODEL =
  process.env.IROS_PRESEED_MODEL ??
  process.env.IROS_Q_MODEL ??
  process.env.IROS_MODEL ??
  'gpt-5';

function cleanString(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeParseJson(value: unknown): any | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/u);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function compactForPrompt(value: unknown, max = 2200): string {
  try {
    const json = JSON.stringify(value ?? null);
    return json.length > max ? json.slice(0, max) : json;
  } catch {
    const s = String(value ?? '');
    return s.length > max ? s.slice(0, max) : s;
  }
}

function normalizeKind(value: unknown): PreSeedAssistKind {
  const s = cleanString(value);

  if (s === 'diagnosis_target_confirm') return 'diagnosis_target_confirm';
  if (s === 'diagnosis_followup') return 'diagnosis_followup';
  if (s === 'relationship_target_confirm') return 'relationship_target_confirm';
  if (s === 'relationship_followup') return 'relationship_followup';
  if (s === 'previous_event_confirm') return 'previous_event_confirm';

  return 'normal';
}

function normalizeResult(raw: any, fallbackSeedText: string): PreSeedAssistResult {
  const kind = normalizeKind(raw?.kind);
  const confidence = clampConfidence(raw?.confidence);

  const targetLabel = cleanString(raw?.targetLabel) || null;
  const targetKey = cleanString(raw?.targetKey) || null;
  const directReply = cleanString(raw?.directReply) || null;
  const reason = cleanString(raw?.reason) || 'pre-seed assist normalized';

  const rawShouldBypassWriter =
    typeof raw?.shouldBypassWriter === 'boolean'
      ? raw.shouldBypassWriter
      : Boolean(directReply && kind !== 'normal' && confidence >= 0.75);

  // followup は診断・関係の中身を Writer に渡す。
  // directReply で早期終了すると、診断正本を取得しても本文に反映されない。
  const shouldBypassWriter =
    kind === 'diagnosis_followup' || kind === 'relationship_followup'
      ? false
      : rawShouldBypassWriter;

  const seedText =
    cleanString(raw?.seedText) ||
    fallbackSeedText ||
    (directReply ? `PRE_SEED_DIRECT_REPLY: ${directReply}` : '');

  return {
    version: 'pre_seed_assist_v1',
    kind,
    confidence,
    targetLabel,
    targetKey,
    directReply,
    seedText,
    shouldBypassWriter,
    reason,
  };
}

function buildFallbackResult(args: RunPreSeedAssistArgs, reason: string): PreSeedAssistResult {
  const userText = cleanString(args.userText);

  return {
    version: 'pre_seed_assist_v1',
    kind: 'normal',
    confidence: 0,
    targetLabel: null,
    targetKey: null,
    directReply: null,
    seedText: userText ? `PRE_SEED_NORMAL: ${userText}` : '',
    shouldBypassWriter: false,
    reason,
  };
}

export async function runPreSeedAssist(
  args: RunPreSeedAssistArgs,
): Promise<PreSeedAssistResult> {
  const userText = cleanString(args.userText);
  if (!userText) {
    return buildFallbackResult(args, 'empty_user_text');
  }

  const ctxPack = args.ctxPack && typeof args.ctxPack === 'object' ? args.ctxPack : {};
  const activeContextFrame =
    args.activeContextFrame ??
    ctxPack.activeContextFrame ??
    null;

  const lastIrDiagnosis =
    args.lastIrDiagnosis ??
    ctxPack.lastIrDiagnosis ??
    null;

  const historyForWriter = Array.isArray(args.historyForWriter)
    ? args.historyForWriter.slice(-6)
    : Array.isArray(ctxPack.historyForWriter)
      ? ctxPack.historyForWriter.slice(-6)
      : [];

  const system = [
    'あなたは iros の Pre-SEED Assist です。',
    '',
    '役割:',
    '- Writer本文を書くことではありません。',
    '- userText と ctxPack と activeContextFrame から、このターンの正本候補を判定します。',
    '- 診断、人物、関係、前回イベントの確認質問を分類します。',
    '- 返答本文を創作せず、必要なら directReply を短く固定文で返します。',
    '',
    '重要:',
    '- 「誰の診断を深めたのですか？」は、直前診断対象の確認です。',
    '- activeContextFrame に diagnosis_of があり、対象が self/自分なら directReply は「自分の診断です。さっきの「ir診断 自分」を受けて、その内容を少し深めていました。」です。',
    '- directReply を出す場合、shouldBypassWriter は true にします。',
    '- activeContextFrame に diagnosis があり、userText が「それは？」「なぜ？」「どうしたら？」「もう少し」など診断の続きにも通常相談にも見える場合は、kind="diagnosis_target_confirm" とし、directReply で「これは、さっきの診断の続きとして見ますか？それとも、今の相談として新しく見ますか？」と確認します。',
    '- activeContextFrame に diagnosis があり、userText が診断対象・診断本文・直前回答に含まれる具体語へ接続している場合は kind="diagnosis_followup" にします。',
    '- 「別件です」「普通の相談に戻ります」「この診断はここまで」「通常チャット」など明示終了がある場合は kind="normal" にします。',
    '- activeContextFrame がない、または診断との接続が明確にない場合は kind="normal", confidence=0, shouldBypassWriter=false にします。',
    '',
    '出力は JSON 1個のみ。説明文は出さない。',
    'JSON schema:',
    '{',
    '  "kind": "diagnosis_target_confirm" | "diagnosis_followup" | "relationship_target_confirm" | "relationship_followup" | "previous_event_confirm" | "normal",',
    '  "confidence": number,',
    '  "targetLabel": string | null,',
    '  "targetKey": string | null,',
    '  "directReply": string | null,',
    '  "seedText": string,',
    '  "shouldBypassWriter": boolean,',
    '  "reason": string',
    '}',
  ].join('\n');

  const userPayload = {
    userText,
    activeContextFrame,
    lastIrDiagnosis,
    ctxPack: {
      diagnosisFollowup: ctxPack.diagnosisFollowup ?? null,
      diagnosisFollowupTargetLabel: ctxPack.diagnosisFollowupTargetLabel ?? null,
      continuityKind: ctxPack.continuityKind ?? null,
      followupKind: ctxPack.followupKind ?? null,
      activeDiagnosisId: ctxPack.activeDiagnosisId ?? null,
      targetLabel: ctxPack.targetLabel ?? null,
      memoryTargetKey: ctxPack.memoryTargetKey ?? null,
      relationshipDisplayName: ctxPack.relationshipDisplayName ?? null,
      relationId: ctxPack.relationId ?? null,
    },
    historyForWriter,
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        'PRE_SEED_INPUT_JSON:',
        compactForPrompt(userPayload, 5000),
      ].join('\n'),
    },
  ];

  try {
    const raw = await chatComplete({
      purpose: 'judge',
      model: PRESEED_MODEL,
      temperature: 0,
      max_tokens: 360,
      messages,
      responseFormat: { type: 'json_object' },
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      audit: {
        mode: 'pre_seed_assist',
      },
    });

    const parsed = safeParseJson(raw);
    const fallbackSeedText = userText ? `PRE_SEED_NORMAL: ${userText}` : '';
    const result = normalizeResult(parsed, fallbackSeedText);

    console.log('[IROS/PRE_SEED_ASSIST][OK]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      kind: result.kind,
      confidence: result.confidence,
      shouldBypassWriter: result.shouldBypassWriter,
      targetLabel: result.targetLabel,
      directReplyHead: result.directReply ? result.directReply.slice(0, 80) : null,
      seedHead: result.seedText.slice(0, 120),
    });

    return result;
  } catch (error) {
    console.warn('[IROS/PRE_SEED_ASSIST][FAILED]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
      error: String((error as any)?.message ?? error),
    });

    return buildFallbackResult(args, 'llm_failed');
  }
}

