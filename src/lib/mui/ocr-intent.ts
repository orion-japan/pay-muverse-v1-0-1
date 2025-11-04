// OCR 入口：意図だけ聞く（本文には触れない）
export type IntentCategory =
  | '相手の状態を知りたい'
  | '真偽を確かめたい（嘘/本当）'
  | '相手の本音/思い'
  | '返信の仕方を知りたい'
  | '今後の動きを知りたい'
  | 'その他';

export const OCR_INTENT_VIEW = {
  title: 'まずは意図を教えてください（OCR本文には触れません）',
  uiText: `この画面では、スクショの中身には一切触れません。
「あなたが何を知りたいか（意図）」だけを整理します。
このあと Stage1 で無料の初期診断（関係の温度など）を行います。`,
  nextStep: '無料診断（Stage1）に進む',
} as const;

// 入口ガード（この画面では本文に触れない）
export const OCR_PHASE_POLICY = {
  allowContentTalk: false,
  violationMsg:
    'この画面ではスクショの本文には触れません。知りたいこと（意図）だけ教えてくださいね。',
} as const;

// ゆるい検知（自由に調整）
export function isOcrPhaseContentTalk(text: string) {
  return /彼が|既読|未読|返信|言った|スクショ|本文|会話|LINE/i.test(text);
}

// お好みで選べるカテゴリ候補
export const INTENT_CATEGORY_OPTIONS: IntentCategory[] = [
  '相手の状態を知りたい',
  '真偽を確かめたい（嘘/本当）',
  '相手の本音/思い',
  '返信の仕方を知りたい',
  '今後の動きを知りたい',
  'その他',
];
