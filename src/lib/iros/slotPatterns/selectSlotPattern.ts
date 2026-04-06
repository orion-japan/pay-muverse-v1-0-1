import type { PatternKey } from './types';

export type SelectSlotPatternInput = {
  line?: string | null;
  questionType?: string | null;
  detailMode?: boolean | null;
  followupText?: string | null;
  userText?: string | null;
  targetLabel?: string | null;
  hasPriorDiagnosis?: boolean | null;
};

function normalizeLite(value: unknown): string {
  return String(value ?? '').trim().toLowerCase();
}

function isIrLikeLine(value: string): boolean {
  return (
    value === 'ir' ||
    value === 'diagnosis' ||
    value === 'ir_diagnosis' ||
    value === 'ir-detail' ||
    value === 'ir_detail'
  );
}

function isTruthLikeQuestionType(value: string): boolean {
  return value === 'truth' || value === 'fact';
}

function looksLikeDetailFollowup(text: string): boolean {
  if (!text) return false;

  const keywords = [
    '詳しく',
    '具体的',
    '具体的に',
    '分解',
    '整理',
    'この状況から',
    '深く',
    '詳細',
    'くわしく',
  ];

  return keywords.some((word) => text.includes(word));
}

export function selectSlotPattern(input: SelectSlotPatternInput): PatternKey {
  const line = normalizeLite(input?.line);
  const questionType = normalizeLite(input?.questionType);
  const followupText = normalizeLite(input?.followupText);
  const userText = normalizeLite(input?.userText);
  const detailMode = Boolean(input?.detailMode);
  const hasPriorDiagnosis = Boolean(input?.hasPriorDiagnosis);
  const hasTarget = normalizeLite(input?.targetLabel).length > 0;

  const irLike = isIrLikeLine(line);
  const truthLike = isTruthLikeQuestionType(questionType);
  const detailLike =
    detailMode || looksLikeDetailFollowup(followupText) || looksLikeDetailFollowup(userText);

  if (irLike && detailLike && (hasPriorDiagnosis || hasTarget)) {
    return 'IR_DETAIL_V1';
  }

  if (irLike) {
    return 'IR_LIGHT_V1';
  }

  if (truthLike) {
    return 'TRUTH_V1';
  }

  return 'NORMAL_V1';
}
