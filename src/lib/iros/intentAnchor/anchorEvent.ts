import type { VolatilityRank } from '../spin/decideSpinControl';

export type AnchorEvent =
  | { type: 'none' }
  | {
      type: 'confirm';
      question: string;
      options?: string[];
    };

export function decideAnchorEvent(
  rank: VolatilityRank,
  currentAnchorText?: string | null
): AnchorEvent {
  if (rank !== 'high') return { type: 'none' };

  // ★ High のときだけ発火
  return {
    type: 'confirm',
    question: currentAnchorText
      ? `いまの北極星「${currentAnchorText}」は変わっていませんか？`
      : 'いま一番守りたい北極星はどれですか？',
    options: currentAnchorText
      ? ['このまま維持する', '少し修正する']
      : ['安心', '尊厳', '関係', '未来'],
  };
}
