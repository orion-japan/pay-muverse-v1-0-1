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

function looksLikeDecisionAxisFollowup(text: string): boolean {
  if (!text) return false;

  const keywords = [
    '見誤りたくない',
    '違いを知りたい',
    '見分けたい',
    '本当の引っかかり',
    'どっちなのか',
    'どちらなのか',
    '切り替えるべきもの',
    '続けるのか',
    'やめるのか',

    '違い',
    '共通点',
    '比較',
    '比べる',
    '相性',
    '組み合わせ',
    '関係性',
    '関わり合い',
    '問題点',
    '協調',
    '協調する方法',
    '理解点',
    '打ち解ける',
    '打ち解けるには',
    'どう見えやすい',
    'どう映りやすい',
    'ぶつかりやすい',
    'すれ違い',
    '誤解',
    'なぜぶつかる',
    '何がズレる',
    'どこでズレる',
    '原因',
    '何が原因',
    '原因になりやすい',
    'ぶつかる原因',

    'どうしたら良い',
    'どうしたらいい',
    'どうすれば良い',
    'どうすればいい',
    '良い方法はありますか',
    'いい方法はありますか',
    'どう進めたらいい',
    'どう進めたら良い',
    'どう進めればいい',
    'どう進めれば良い',
    '最終的にどうしたら',
    '最終的にどうすれば',
  ];

  return keywords.some((word) => text.includes(word));
}
function looksLikeDeclarationResonance(text: string): boolean {
  if (!text) return false;

  const declarationPatterns = [
    /私が[^\n。]*する/,
    /私は[^\n。]*する/,
    /私は[^\n。]*やる/,
    /私が[^\n。]*作る/,
    /私が[^\n。]*創る/,
    /私は[^\n。]*立ちます/,
    /私は[^\n。]*変えていきます/,
    /私は[^\n。]*動かします/,
    /私は[^\n。]*預けません/,
    /私は[^\n。]*前に出ます/,
    /私は[^\n。]*見え始めます/,
    /訪れます/,
    /始まります/,
    /現実を作ります/,
  ];

  const explanationPatterns = [
    /教えて/,
    /なぜ/,
    /どうして/,
    /とは/,
    /ですか/,
    /ますか/,
    /詳しく/,
    /具体的/,
  ];

  const hasDeclaration = declarationPatterns.some((pattern) => pattern.test(text));
  const hasExplanationRequest = explanationPatterns.some((pattern) => pattern.test(text));

  return hasDeclaration && !hasExplanationRequest;
}

export function selectSlotPattern(input: SelectSlotPatternInput): PatternKey {
  const line = normalizeLite(input?.line);
  const questionType = normalizeLite(input?.questionType);
  const followupText = String(input?.followupText ?? '').trim();
  const userText = String(input?.userText ?? '').trim();
  const detailMode = Boolean(input?.detailMode);

  const irLike = isIrLikeLine(line);
  const truthLike = isTruthLikeQuestionType(questionType);
  const detailLike =
    detailMode ||
    looksLikeDetailFollowup(normalizeLite(followupText)) ||
    looksLikeDetailFollowup(normalizeLite(userText)) ||
    looksLikeDecisionAxisFollowup(normalizeLite(followupText)) ||
    looksLikeDecisionAxisFollowup(normalizeLite(userText));

  const declarationLike = looksLikeDeclarationResonance(followupText || userText);

  // ir診断の詳細化は IR_DETAIL_V1
  if (irLike && detailLike) {
    return 'IR_DETAIL_V1';
  }

  // ir診断の初回や通常診断は IR_LIGHT_V1
  if (irLike) {
    return 'IR_LIGHT_V1';
  }

  // 宣言文・共鳴文は DECLARATION_RESONANCE_V1
  if (!truthLike && declarationLike) {
    return 'DECLARATION_RESONANCE_V1';
  }

  // truth系でも、比較・相性・関係説明は DETAIL を優先する
  if (
    truthLike &&
    (looksLikeDecisionAxisFollowup(normalizeLite(followupText)) ||
      looksLikeDecisionAxisFollowup(normalizeLite(userText)))
  ) {
    return 'NORMAL_DETAIL_V1';
  }

  // truth系は TRUTH_COMPRESSED_V1
  if (truthLike) {
    return 'TRUTH_COMPRESSED_V1';
  }

  // 通常会話で detail 指示があるときだけ DETAIL
  if (detailLike) {
    return 'NORMAL_DETAIL_V1';
  }

  // 通常会話の既定は COMPRESSED
  return 'NORMAL_COMPRESSED_V1';
}
