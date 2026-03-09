// src/lib/iros/question/detectTMode.ts
// IROS QuestionEngine v1
// Phase5: T mode detection (rule-based / safe-first)

import type { DetectTModeInput, TMode, TState } from './types';

function normalizeText(input: string): string {
  return String(input ?? '').trim();
}

function pickFocus(input: DetectTModeInput): string | null {
  const text = normalizeText(input.userText ?? '');

  if (input.pastResolve?.candidateThemes?.length) {
    return input.pastResolve.candidateThemes[0] ?? null;
  }

  if (input.iframe?.focusCandidate?.length) {
    return input.iframe.focusCandidate[0] ?? null;
  }

  if (/未来|これから|次|今後/.test(text)) return '次の一手';
  if (/比較|違い|どれ|どちら/.test(text)) return '比較観点';
  if (/なぜ|原因|どうして/.test(text)) return '原因';
  if (/意味|意義/.test(text)) return '意味';

  return null;
}

export function detectTMode(input: DetectTModeInput): TState {
  const text = normalizeText(input.userText ?? '');

  let mode: TMode = 'confirm';
  let reason = 'default_confirm';

  if (input.pastResolve?.detected) {
    mode = 'reobserve_past';
    reason = 'past_resolve_detected';
  } else if (
    input.questionType === 'future_design' ||
    /未来|これから|今後|次に|作りたい|進めたい|実装したい/.test(text)
  ) {
    mode = 'explore_future';
    reason =
      input.questionType === 'future_design'
        ? 'question_type_future_design'
        : 'future_keyword';
  } else if (/比較|違い|どれ|どちら|複数/.test(text)) {
    mode = 'compare_models';
    reason = 'compare_keyword';
  } else if (
    /設計|構成|方針|プラン|組み立て/.test(text) &&
    input.questionType !== 'truth'
  ) {
    mode = 'design_probe';
    reason = 'design_keyword';
  }

  return {
    mode,
    focus: pickFocus(input),
    reason,
  };
}
