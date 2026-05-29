export type WorkingReferenceAskType =
  | 'reference_check'
  | 'reference_followup';

export type WorkingReferenceReadingMode =
  | 'deictic_reference'
  | 'situational_reference';

export type WorkingReference = {
  askType: WorkingReferenceAskType;
  currentQuestion: string;
  referenceTarget: string;
  mainSubject: string | null;
  sourceUserText: string;
  sourceAssistantText: string;
  sourcePreviousUserText: string;
  readingMode: WorkingReferenceReadingMode;
  askFrame: string;
  sourcePhrase: string | null;
  scope: 'current_turn';
  expiresAfterTurn: true;
  confidence: number;
};

export type ResolveWorkingReferenceArgs = {
  currentQuestion: string;
  historyForTurn?: unknown[];
  orchCtxPack?: any;
  orchExtra?: any;
  extraLocal?: any;
};

function pickText(currentQuestion: string, ...cands: any[]): string | null {
  for (const v of cands) {
    if (v === undefined || v === null) continue;

    const s = String(v).replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (s === currentQuestion) continue;

    if (
      /(これ|それ)/u.test(s) &&
      /沿って/u.test(s)
    ) {
      continue;
    }

    return s;
  }

  return null;
}

function pickAssistantContent(m: any): string {
  if (!m || typeof m !== 'object') return '';

  const role = String(m?.role ?? m?.type ?? '').trim();
  if (!/^(assistant|ai|model|iros|mu)$/i.test(role)) return '';

  const content =
    typeof m?.content === 'string'
      ? String(m.content).trim()
      : typeof m?.text === 'string'
        ? String(m.text).trim()
        : typeof m?.assistantText === 'string'
          ? String(m.assistantText).trim()
          : typeof m?.message === 'string'
            ? String(m.message).trim()
            : '';

  if (!content) return '';
  if (/^(SEED|INTERNAL PACK|HISTORY_LITE|WRITER_DIRECTIVES|PATTERN_OUTPUT_CONTRACT)/u.test(content)) {
    return '';
  }

  return content.replace(/\s+/g, ' ').trim();
}

function pickUserContent(currentQuestion: string, m: any): string {
  if (!m || typeof m !== 'object') return '';

  const role = String(m?.role ?? m?.type ?? '').trim();
  if (!/^user$/i.test(role)) return '';

  const content =
    typeof m?.content === 'string'
      ? String(m.content).trim()
      : typeof m?.text === 'string'
        ? String(m.text).trim()
        : typeof m?.message === 'string'
          ? String(m.message).trim()
          : '';

  if (!content) return '';
  if (content === currentQuestion) return '';

  return content.replace(/\s+/g, ' ').trim();
}

function cleanReferenceTarget(s: string | null): string | null {
  const raw = String(s ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const cleaned = raw
    .replace(/を教えてください.*$/u, '')
    .replace(/について教えてください.*$/u, '')
    .replace(/とは.*$/u, '')
    .trim();

  return cleaned || raw;
}

export function resolveWorkingReference(args: ResolveWorkingReferenceArgs): WorkingReference | null {
  const currentQuestion = String(args.currentQuestion ?? '').trim();
  if (!currentQuestion) return null;

  const situationalReferenceCheckMatch =
    currentQuestion.match(/^この場合、?(.+?)、?に沿って(?:ます|います)か[？?]?$/u) ||
    currentQuestion.match(/^この条件で、?(.+?)、?に沿って(?:ます|います)か[？?]?$/u) ||
    currentQuestion.match(/^この文は、?(.+?)という意味に沿って(?:ます|います)か[？?]?$/u);

  const isSituationalReferenceCheck = Boolean(situationalReferenceCheckMatch);

  const isDeictic =
    /(これ|それ)/u.test(currentQuestion) &&
    (
      /これに沿って/u.test(currentQuestion) ||
      /それに沿って/u.test(currentQuestion) ||
      /これとは/u.test(currentQuestion) ||
      /それとは/u.test(currentQuestion) ||
      /これは何/u.test(currentQuestion) ||
      /それって何/u.test(currentQuestion) ||
      /今のAIは.*これに沿って/u.test(currentQuestion) ||
      /沿ってますか/u.test(currentQuestion) ||
      /沿っていますか/u.test(currentQuestion) ||
      /これ.*ですか/u.test(currentQuestion) ||
      /それ.*ですか/u.test(currentQuestion)
    );

  if (!isDeictic && !isSituationalReferenceCheck) return null;

  const historyCandidatesForReference = [
    Array.isArray(args.historyForTurn) ? args.historyForTurn : [],
    Array.isArray(args.orchCtxPack?.historyForWriter)
      ? args.orchCtxPack.historyForWriter
      : [],
    Array.isArray(args.orchExtra?.ctxPack?.historyForWriter)
      ? args.orchExtra.ctxPack.historyForWriter
      : [],
    Array.isArray(args.extraLocal?.ctxPack?.historyForWriter)
      ? args.extraLocal.ctxPack.historyForWriter
      : [],
  ];

  const reversedHistory = historyCandidatesForReference.flatMap((items) => [...items].reverse());

  const sourceAssistantText =
    reversedHistory
      .map(pickAssistantContent)
      .find(Boolean) ?? '';

  const sourcePreviousUserText =
    reversedHistory
      .map((m) => pickUserContent(currentQuestion, m))
      .find(Boolean) ?? '';

  const historyDigestV1 =
    args.orchCtxPack?.historyDigestV1 ??
    args.orchExtra?.ctxPack?.historyDigestV1 ??
    args.orchExtra?.historyDigestV1 ??
    args.extraLocal?.ctxPack?.historyDigestV1 ??
    null;

  const referenceTarget = cleanReferenceTarget(
    pickText(
      currentQuestion,
      sourcePreviousUserText,
      sourceAssistantText,
      historyDigestV1?.topic?.situationTopic,
      historyDigestV1?.topic?.situationSummary,
      historyDigestV1?.situationTopic,
      historyDigestV1?.situationSummary,
      args.orchCtxPack?.topicDigest,
      args.orchExtra?.topicDigest,
      args.orchCtxPack?.conversationLine
    )
  );

  if (!referenceTarget) return null;

  const subjectMatch =
    situationalReferenceCheckMatch ||
    currentQuestion.match(/^(.+?)は、?これに沿って/u) ||
    currentQuestion.match(/^(.+?)は、?それに沿って/u) ||
    currentQuestion.match(/^(.+?)は.*沿って(?:ます|います)か/u);

  const mainSubject =
    pickText(currentQuestion, subjectMatch?.[1]) ??
    (/^(これ|それ)とは/u.test(currentQuestion) || /^(これは|それは)何/u.test(currentQuestion)
      ? 'これ'
      : null);

  const askFrame =
    mainSubject && mainSubject !== 'これ' && mainSubject !== 'それ'
      ? `${referenceTarget.slice(0, 120)}に照らして${mainSubject}を判定する`
      : `${referenceTarget.slice(0, 120)}が何を指すかを説明する`;

  return {
    askType: 'reference_check',
    currentQuestion,
    referenceTarget,
    mainSubject,
    sourceUserText: currentQuestion,
    sourceAssistantText,
    sourcePreviousUserText,
    readingMode: isSituationalReferenceCheck ? 'situational_reference' : 'deictic_reference',
    askFrame,
    sourcePhrase: isSituationalReferenceCheck
      ? 'この場合'
      : /それ/u.test(currentQuestion)
        ? 'それ'
        : /これ/u.test(currentQuestion)
          ? 'これ'
          : null,
    scope: 'current_turn',
    expiresAfterTurn: true,
    confidence: isSituationalReferenceCheck ? 0.9 : 0.86,
  };
}