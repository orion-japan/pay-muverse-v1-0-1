// src/lib/iros/question/index.ts
// IROS QuestionEngine v1
// - orchestrator から呼ばれる統合入口
// - 初版は “安全な骨格” を先に作る
// - 文章生成は行わず、問い構造だけ返す

import type {
  DomainType,
  IFrame,
  OutputPolicy,
  PastResolveState,
  QuestionEngineInput,
  QuestionEngineResult,
  QuestionType,
  TState,
} from './types';
import { detectDomain } from './detectDomain';
import { detectQuestionType } from './detectQuestionType';
import { buildIFrame } from './buildIFrame';
import { detectPastResolve } from './detectPastResolve';
import { detectTMode } from './detectTMode';
import { buildOutputPolicy } from './buildOutputPolicy';

function fallbackDomain(input: QuestionEngineInput): DomainType {
  return detectDomain({
    userText: input.userText,
    context: input.context ?? null,
  });
}

function fallbackQuestionType(input: QuestionEngineInput, domain: DomainType): QuestionType {
  return detectQuestionType({
    userText: input.userText,
    qCode: input.qCode ?? null,
    eTurn: input.eTurn ?? null,
    signals: input.signals ?? null,
    context: input.context ?? null,
    domain,
  });
}

function fallbackIFrame(
  input: QuestionEngineInput,
  domain: DomainType,
  questionType: QuestionType,
): IFrame {
  return buildIFrame({
    userText: input.userText,
    domain,
    questionType,
  });
}

function fallbackPastResolve(input: QuestionEngineInput): PastResolveState | null {
  return detectPastResolve({
    userText: input.userText,
    context: input.context ?? null,
  });
}

function fallbackTMode(
  input: QuestionEngineInput,
  questionType: QuestionType,
  pastResolve: PastResolveState | null,
  iframe: IFrame | null,
): TState {
  return detectTMode({
    userText: input.userText,
    questionType,
    pastResolve,
    iframe,
  });
}

export function runQuestionEngine(input: QuestionEngineInput): QuestionEngineResult {
  console.log('[IROS/IT][INPUT]', {
    hasUserText: String(input.userText ?? '').trim().length > 0,
    qCode: input.qCode ?? null,
    eTurn: input.eTurn ?? null,
    hasSignals: !!input.signals,
    hasIntentLine: input.intentLine != null,
    hasIntentTransition: input.intentTransition != null,
  });

  const domain = fallbackDomain(input);
  console.log('[IROS/IT][DOMAIN]', { domain });

  const questionType = fallbackQuestionType(input, domain);
  console.log('[IROS/IT][QTYPE]', { questionType });
// ✅ 非質問はここで完全スキップ
if (!questionType) {
  return {
    domain,
    questionType: null,
    iframe: null,
    pastResolve: null,
    tState: null,
    outputPolicy: null,
  };
}
  const iframe = fallbackIFrame(input, domain, questionType);
  console.log('[IROS/IT][IFRAME]', {
    domain: iframe.domain,
    questionType: iframe.questionType,
    topic: iframe.topic,
    hypothesisSpaceLen: iframe.hypothesisSpace.length,
    focusCandidateLen: iframe.focusCandidate.length,
    hypothesisKeys: iframe.hypothesisSpace.map((x) => x.key),
    focusCandidate: iframe.focusCandidate,
  });

  const pastResolve = fallbackPastResolve(input);
  console.log('[IROS/IT][PAST_RESOLVE]', {
    detected: !!pastResolve?.detected,
    cues: pastResolve?.cues ?? [],
    candidateThemes: pastResolve?.candidateThemes ?? [],
  });

  const tState = fallbackTMode(input, questionType, pastResolve, iframe);
  console.log('[IROS/IT][T_MODE]', tState);

  const sameTopicTurns =
    typeof (input.context as any)?.sameTopicTurns === 'number'
      ? (input.context as any).sameTopicTurns
      : 0;
  console.log('[IROS/IT][SAME_TOPIC_TURNS]', { sameTopicTurns });

  const outputPolicy = buildOutputPolicy(questionType, tState.mode, pastResolve, sameTopicTurns);
  console.log('[IROS/IT][OUTPUT_POLICY]', outputPolicy);

  return {
    domain,
    questionType,
    iframe,
    pastResolve,
    tState,
    outputPolicy,
  };
}
