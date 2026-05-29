import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';

const REFERENCE_JUDGE_MODEL =
  process.env.IROS_REFERENCE_JUDGE_MODEL ??
  process.env.IROS_JUDGE_MODEL ??
  process.env.IROS_MODEL ??
  process.env.OPENAI_MODEL ??
  'gpt-5';

export type ReferenceJudgeDomain =
  | 'ordinary'
  | 'medical'
  | 'legal'
  | 'financial'
  | 'religious_philosophical'
  | 'technical'
  | 'relationship'
  | 'iros_internal'
  | 'unknown';

export type ReferenceJudgeRelation =
  | 'identical'
  | 'mostly_aligned'
  | 'partial_structural'
  | 'analogous_only'
  | 'not_identical'
  | 'unclear';

export type ReferenceJudgeRisk = 'low' | 'medium' | 'high';

export type ReferenceJudgeAnswerMode =
  | 'answer_first'
  | 'not_identical_but_structurally_partial'
  | 'informational_only'
  | 'professional_boundary'
  | 'needs_verification'
  | 'cannot_determine'
  | 'unclear';

export type ReferenceJudgeResult = {
  ok: boolean;
  source: 'llm' | 'fallback';
  askType: 'reference_check';
  referenceTarget: string | null;
  mainSubject: string | null;
  currentQuestion: string | null;
  askFrame: string | null;
  domain: ReferenceJudgeDomain;
  relation: ReferenceJudgeRelation;
  risk: ReferenceJudgeRisk;
  answerMode: ReferenceJudgeAnswerMode;
  structureViewAllowed: boolean;
  cannotAnswerDefinitively: boolean;
  mustNot: string[];
  writerFirstLine: string | null;
  judgementSummary: string | null;
};

export type JudgeReferenceInput = {
  referenceTarget: string | null;
  mainSubject: string | null;
  currentQuestion: string | null;
  askFrame?: string | null;
  sourceAssistantText?: string | null;
  sourcePreviousUserText?: string | null;
  traceId?: string | null;
  conversationId?: string | null;
  userCode?: string | null;
};

function cleanText(value: unknown, max = 1400): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function asOneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const v = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function asStringOrNull(value: unknown, max = 240): string | null {
  const text = cleanText(value, max);
  return text ? text : null;
}

function asStringArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanText(v, 120))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeParseJson(text: string): any | null {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // continue
  }

  const match = trimmed.match(/\{[\s\S]*\}/u);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function fallbackJudge(input: JudgeReferenceInput): ReferenceJudgeResult {
  return {
    ok: false,
    source: 'fallback',
    askType: 'reference_check',
    referenceTarget: asStringOrNull(input.referenceTarget),
    mainSubject: asStringOrNull(input.mainSubject),
    currentQuestion: asStringOrNull(input.currentQuestion),
    askFrame: asStringOrNull(input.askFrame),
    domain: 'unknown',
    relation: 'unclear',
    risk: 'medium',
    answerMode: 'cannot_determine',
    structureViewAllowed: true,
    cannotAnswerDefinitively: true,
    mustNot: ['do_not_invent', 'do_not_overstate', 'say_cannot_determine_if_needed'],
    writerFirstLine: '今の情報だけでは、はっきり断定できません。',
    judgementSummary:
      '参照対象と判定対象の関係を確定できないため、構造として見られる範囲に限定する。',
  };
}

export function formatReferenceJudgeSeed(result: ReferenceJudgeResult | null): string {
  if (!result) return '';

  return [
    'REFERENCE_JUDGEMENT:',
    `source=${result.source}`,
    `askType=${result.askType}`,
    `referenceTarget=${result.referenceTarget ?? '(null)'}`,
    `mainSubject=${result.mainSubject ?? '(null)'}`,
    `domain=${result.domain}`,
    `relation=${result.relation}`,
    `risk=${result.risk}`,
    `answerMode=${result.answerMode}`,
    `structureViewAllowed=${result.structureViewAllowed ? 'true' : 'false'}`,
    `cannotAnswerDefinitively=${result.cannotAnswerDefinitively ? 'true' : 'false'}`,
    `writerFirstLine=${result.writerFirstLine ?? '(null)'}`,
    `judgementSummary=${result.judgementSummary ?? '(null)'}`,
    `mustNot=${result.mustNot.join(' / ') || '(none)'}`,
  ].join('\n');
}

export async function judgeReferenceCheck(
  input: JudgeReferenceInput,
): Promise<ReferenceJudgeResult> {
  const referenceTarget = asStringOrNull(input.referenceTarget);
  const mainSubject = asStringOrNull(input.mainSubject);
  const currentQuestion = asStringOrNull(input.currentQuestion);

  if (!referenceTarget || !mainSubject || !currentQuestion) {
    return fallbackJudge(input);
  }

  const systemPrompt = [
    'You are a judgement classifier for IROS.',
    'Return JSON only.',
    'Do not write the final user-facing answer.',
    'Classify the relation between referenceTarget and mainSubject for a reference_check question.',
    '',
    'Important policy:',
    '- If a definitive answer is not possible, set cannotAnswerDefinitively=true.',
    '- For medical, legal, or financial topics, do not provide professional diagnosis/advice. Use professional_boundary or informational_only.',
    '- For relationship mind-reading, do not claim certainty about another person’s inner state.',
    '- For technical or implementation questions, require code/log verification when needed.',
    '- For religious/philosophical/practice/body concepts, distinguish identity from structural analogy.',
    '- The system may allow structureViewAllowed=true when it can discuss structure without overclaiming.',
    '',
    'Allowed domain values:',
    'ordinary, medical, legal, financial, religious_philosophical, technical, relationship, iros_internal, unknown',
    '',
    'Allowed relation values:',
    'identical, mostly_aligned, partial_structural, analogous_only, not_identical, unclear',
    '',
    'Allowed risk values:',
    'low, medium, high',
    '',
    'Allowed answerMode values:',
    'answer_first, not_identical_but_structurally_partial, informational_only, professional_boundary, needs_verification, cannot_determine, unclear',
    '',
    'Output JSON shape:',
    '{',
    '  "domain": "...",',
    '  "relation": "...",',
    '  "risk": "...",',
    '  "answerMode": "...",',
    '  "structureViewAllowed": true,',
    '  "cannotAnswerDefinitively": false,',
    '  "mustNot": ["..."],',
    '  "writerFirstLine": "short Japanese first line",',
    '  "judgementSummary": "short Japanese summary"',
    '}',
  ].join('\n');

  const userPayload = {
    askType: 'reference_check',
    referenceTarget,
    mainSubject,
    currentQuestion,
    askFrame: asStringOrNull(input.askFrame),
    sourcePreviousUserText: asStringOrNull(input.sourcePreviousUserText, 500),
    sourceAssistantText: asStringOrNull(input.sourceAssistantText, 1200),
  };

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(userPayload) },
  ];

  try {
    const raw = await chatComplete({
      purpose: 'judge',
      model: REFERENCE_JUDGE_MODEL,
      temperature: 0,
      max_tokens: 500,
      messages,
      responseFormat: { type: 'json_object' },
      traceId: input.traceId ?? null,
      conversationId: input.conversationId ?? null,
      userCode: input.userCode ?? null,
    });

    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      return fallbackJudge(input);
    }

    const domains = [
      'ordinary',
      'medical',
      'legal',
      'financial',
      'religious_philosophical',
      'technical',
      'relationship',
      'iros_internal',
      'unknown',
    ] as const;

    const relations = [
      'identical',
      'mostly_aligned',
      'partial_structural',
      'analogous_only',
      'not_identical',
      'unclear',
    ] as const;

    const risks = ['low', 'medium', 'high'] as const;

    const answerModes = [
      'answer_first',
      'not_identical_but_structurally_partial',
      'informational_only',
      'professional_boundary',
      'needs_verification',
      'cannot_determine',
      'unclear',
    ] as const;

    return {
      ok: true,
      source: 'llm',
      askType: 'reference_check',
      referenceTarget,
      mainSubject,
      currentQuestion,
      askFrame: asStringOrNull(input.askFrame),
      domain: asOneOf(parsed.domain, domains, 'unknown'),
      relation: asOneOf(parsed.relation, relations, 'unclear'),
      risk: asOneOf(parsed.risk, risks, 'medium'),
      answerMode: asOneOf(parsed.answerMode, answerModes, 'unclear'),
      structureViewAllowed: Boolean(parsed.structureViewAllowed),
      cannotAnswerDefinitively: Boolean(parsed.cannotAnswerDefinitively),
      mustNot: asStringArray(parsed.mustNot),
      writerFirstLine: asStringOrNull(parsed.writerFirstLine, 160),
      judgementSummary: asStringOrNull(parsed.judgementSummary, 300),
    };
  } catch (error) {
    console.warn('[IROS/referenceJudge][ERROR]', error);
    return fallbackJudge(input);
  }
}