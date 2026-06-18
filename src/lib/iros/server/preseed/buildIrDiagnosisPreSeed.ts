import type { PreSeedDecision, ResolvePreSeedDecisionArgs } from './types';

function s(v: any): string {
  return String(v ?? '').trim();
}

function normalizeTargetKey(v: any): string {
  return s(v)
    .replace(/[ \t\r\n　]/g, '')
    .replace(/さん$/u, '')
    .replace(/先生$/u, '')
    .replace(/様$/u, '')
    .toLowerCase();
}

function getTurnText(t: any): string {
  return s(
    t?.content ??
      t?.text ??
      t?.assistantText ??
      t?.message ??
      t?.body ??
      ''
  );
}

function getMeta(t: any): any {
  return t?.meta ?? t?.metadata ?? t?.raw?.meta ?? null;
}

function pickTextFromLastIrDiagnosis(obj: any): string {
  return s(
    obj?.diagnosis_text ??
      obj?.diagnosisText ??
      obj?.summary ??
      obj?.observation ??
      obj?.state ??
      obj?.sourceText ??
      obj?.text ??
      ''
  );
}

function targetMatches(args: { targetKey: string | null; targetLabel: string | null; candidate: any }): boolean {
  const targetKey = normalizeTargetKey(args.targetKey ?? args.targetLabel ?? '');
  if (!targetKey) return false;

  const c = args.candidate;

  const vals = [
    c?.target_key,
    c?.targetKey,
    c?.structuredTargetKey,
    c?.target_label,
    c?.targetLabel,
    c?.target,
    c?.label,
    c?.person,
    c?.displayName,
  ]
    .map(normalizeTargetKey)
    .filter(Boolean);

  return vals.some((v) => v === targetKey || v.includes(targetKey) || targetKey.includes(v));
}

async function fetchFromIrDiagnosisResults(args: {
  supabase: any;
  userCode: string;
  targetKey: string;
  targetLabel: string | null;
}): Promise<any | null> {
  const supabase = args.supabase;
  if (!supabase) return null;

  const targetKey = normalizeTargetKey(args.targetKey);
  const targetLabel = s(args.targetLabel ?? args.targetKey);

  const selectCols = '*';

  const attempts: Array<() => Promise<any>> = [
    () =>
      supabase
        .from('iros_ir_diagnosis_results')
        .select(selectCols)
        .eq('owner_user_code', args.userCode)
        .eq('target_key', targetKey)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),

    () =>
      supabase
        .from('iros_ir_diagnosis_results')
        .select(selectCols)
        .eq('owner_user_code', args.userCode)
        .ilike('target_label', `%${targetLabel}%`)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
  ];

  for (const run of attempts) {
    try {
      const res = await run();
      if (res?.data?.diagnosis_text) return res.data;
      if (res?.error) {
        console.warn('[IROS/PRE_SEED_IR][DB_ATTEMPT_FAILED]', {
          message: res.error?.message ?? res.error,
        });
      }
    } catch (e: any) {
      console.warn('[IROS/PRE_SEED_IR][DB_ATTEMPT_ERROR]', {
        message: e?.message ?? e,
      });
    }
  }

  return null;
}

function fetchFromHistory(args: {
  historyForTurn: any[];
  targetKey: string;
  targetLabel: string | null;
}): any | null {
  const history = Array.isArray(args.historyForTurn) ? args.historyForTurn.slice().reverse() : [];
  const targetKey = normalizeTargetKey(args.targetKey);
  const targetLabel = s(args.targetLabel ?? args.targetKey);

  for (const m of history) {
    const meta = getMeta(m);
    const ex = meta?.extra ?? meta ?? {};
    const cp = ex?.ctxPack ?? meta?.ctxPack ?? {};

    const candidates = [
      cp?.lastIrDiagnosis,
      ex?.lastIrDiagnosis,
      cp?.irMeta,
      ex?.irMeta,
      cp?.activeContextFrame,
      cp?.resolvedAsk,
      ex?.resolvedAsk,
    ].filter(Boolean);

    for (const c of candidates) {
      if (!targetMatches({ targetKey, targetLabel, candidate: c })) continue;

      const directText = pickTextFromLastIrDiagnosis(c);

      const resolvedAskText = s(
        c?.referenceTarget ??
          c?.sourceAssistantText ??
          c?.sourceAssistantTextHead ??
          c?.meaningCore ??
          ''
      );

      const text = directText || resolvedAskText;

      if (text) {
        return {
          id: c?.id ?? c?.diagnosisId ?? c?.activeDiagnosisId ?? null,
          target_label: c?.targetLabel ?? c?.target_label ?? targetLabel,
          target_key: c?.targetKey ?? c?.target_key ?? targetKey,
          diagnosis_text: text,
          source: 'history_ctxPack',
          raw: c,
        };
      }
    }

    const content = getTurnText(m);

    // history_text fallback is intentionally disabled.
    // Do not use prior assistant visible replies as diagnosis authority.
  }

  return null;
}

function buildIrDiagnosisSeed(args: {
  userText: string;
  targetLabel: string | null;
  targetKey: string;
  sourceId: string | number | null;
  sourceText: string;
}): string {
  return [
    'IR_DIAGNOSIS_FOLLOWUP_SEED (DO NOT OUTPUT):',
    'source=iros_ir_diagnosis_results_or_ctxPack',
    `sourceId=${args.sourceId ?? ''}`,
    `targetLabel=${args.targetLabel ?? ''}`,
    `targetKey=${args.targetKey}`,
    `userText=${args.userText}`,
    'sourceAuthority=ir_diagnosis_text',
    'memoryIntent=ir_diagnosis_recall',
    'route=diagnosis_writer',
    '',
    'RULES:',
    'このターンはIR診断結果の続き相談。',
    '対象者が一致するIR診断だけを正本にする。',
    '診断本文の貼り直しを求めない。',
    '過去assistant本文を正本にしない。ただしctxPack/resolvedAskに保存された診断正本は使用してよい。',
    '他人物の診断を混ぜない。',
    '通常チャットの共鳴返答へ戻さない。',
    '診断結果の再要約だけで終わらせず、ユーザーの現在の問いに答える。',
    '診断本文から具体語を2つ以上使う。',
    '最後を不要な質問で終わらせない。',
    '',
    'DIAGNOSIS_TEXT:',
    args.sourceText,
  ].join('\n');
}

export async function buildIrDiagnosisPreSeed(
  args: ResolvePreSeedDecisionArgs & {
    targetKey: string;
    targetLabel?: string | null;
    matchedPattern?: string | null;
  }
): Promise<PreSeedDecision | null> {
  const userText = s(args.userText);
  const targetKey = normalizeTargetKey(args.targetKey);
  const targetLabel = s(args.targetLabel ?? args.targetKey) || args.targetKey;

  if (!userText || !targetKey) return null;

  const fromDb = await fetchFromIrDiagnosisResults({
    supabase: args.supabase,
    userCode: args.userCode,
    targetKey,
    targetLabel,
  });

  const fromHistory =
    fromDb ??
    fetchFromHistory({
      historyForTurn: args.historyForTurn ?? [],
      targetKey,
      targetLabel,
    });

  const source = fromDb ?? fromHistory;

  if (!source?.diagnosis_text) {
    console.warn('[IROS/PRE_SEED_IR][SOURCE_NOT_FOUND]', {
      traceId: args.traceId ?? null,
      conversationId: args.conversationId,
      userCode: args.userCode,
      targetKey,
      targetLabel,
    });
    return null;
  }

  const sourceText = s(source.diagnosis_text);
  const sourceId = source.id ?? null;

  const seedText = buildIrDiagnosisSeed({
    userText,
    targetLabel,
    targetKey,
    sourceId,
    sourceText,
  });

  console.log('[IROS/PRE_SEED_IR][SOURCE_FOUND]', {
    traceId: args.traceId ?? null,
    conversationId: args.conversationId,
    userCode: args.userCode,
    targetKey,
    targetLabel,
    sourceId,
    source: source.source ?? 'iros_ir_diagnosis_results',
    sourceTextLen: sourceText.length,
    sourceTextHead: sourceText.slice(0, 120),
  });

  return {
    kind: 'ir_diagnosis_recall',
    confidence: 0.92,
    sourceAuthority: 'ir_diagnosis_text',
    sourceKind: source.source ?? 'iros_ir_diagnosis_results',
    sourceId,
    route: 'diagnosis_writer',

    sourceText,
    seedText,

    directReply: null,

    writerInput: {
      writerKind: 'diagnosis_writer',
      diagnosisKind: 'ir_diagnosis',
      displayId: typeof sourceId === 'number' ? sourceId : 0,
      sourceLabel: 'ir_diagnosis',
      targetLabel,
      targetKey,
      userText,
      sourceText,
      seedText,
      traceId: args.traceId ?? null,
      conversationId: args.conversationId ?? null,
      userCode: args.userCode ?? null,
    },

    shouldBypassWriter: true,
    shouldBypassRephrase: true,
    shouldUsePreSeedWriter: true,
    shouldSuppressHistoryForWriter: true,
    shouldSuppressSimilarFlow: true,
    shouldSuppressSlotPlan: true,
    shouldSuppressNormalResonance: true,

    metaPatch: {
      preSeedIrDiagnosis: true,
      memoryIntent: 'ir_diagnosis_recall',
      memorySpace: 'ir_diagnosis',
      sourceAuthority: 'ir_diagnosis_text',
      targetLabel,
      targetKey,
      sourceId,
    },

    ctxPackPatch: {
      preSeedIrDiagnosis: true,
      diagnosisFollowup: true,
      presentationKind: 'diagnosis_followup',
      memoryIntent: 'ir_diagnosis_recall',
      memorySpace: 'ir_diagnosis',
      memoryTargetLabel: targetLabel,
      memoryTargetKey: targetKey,
      targetLabel,
      targetKey,
      sourceAuthority: 'ir_diagnosis_text',
      sourceText,
      seedText,
    },

    debug: {
      reason: 'ir_diagnosis_recall_source_found',
      matchedPattern: args.matchedPattern ?? null,
      targetKey,
      routeReason: 'universal_preseed_ir_diagnosis_recall',
    },
  } as any;
}



