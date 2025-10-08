// src/lib/mui/ocr-intent.ts
export type IntentCategory =
  | '相手の状態を知りたい'
  | '真偽を確かめたい（嘘/本当）'
  | '相手の本音/思い'
  | '返信の仕方を知りたい'
  | '今後の動きを知りたい'
  | 'その他';

export const OCR_INTENT_VIEW = {
  title: 'まずは意図を教えてください（OCR本文には触れません）',
  uiText:
`この画面では、スクショの内容には一切触れず、
「あなたが何を知りたいか（意図）」だけを整理します。
このあと Stage1 で無料の初期診断（関係の温度など）を行います。`,

  // ← Muiのsystemに渡すガード（本文に触れない）
  sysPrompt:
`あなたは恋愛相談の入口ガイドです。ここではOCR本文や会話内容には触れません。
ユーザーの「知りたいこと（意図）」だけを2行以内で言い換え、カテゴリを1つ付与してください。
禁止: OCR内容の要約/推測/評価/分析/助言。意図の確認と仕組み説明のみ。
出力JSON:
{ "intent_text":"…", "intent_category":"相手の状態を知りたい|真偽を確かめたい（嘘/本当）|相手の本音/思い|返信の仕方を知りたい|今後の動きを知りたい|その他" }`,

  nextStep: '無料診断（Stage1）に進む'
} as const;

// 画面内の固定コピー（機能説明）
export const OCR_EXPLAIN_COPY = [
  '① スクショをアップ → AIが文字起こし（ここでは中身に触れません）',
  '② あなたの「知りたいこと」を1つだけ入力',
  '③ 次の画面（Stage1）で、無料の初期診断を表示'
] as const;

// 入口ガード（この画面では本文を触らない）
export const OCR_PHASE_POLICY = {
  allowContentTalk: false,
  violationMsg:
    'この画面ではスクショの本文には触れません。知りたいこと（意図）だけ教えてくださいね。'
} as const;

export function isOcrPhaseContentTalk(text: string) {
  // ゆるい検知（自由に調整）
  return /彼が|既読|未読|返信|◯◯と言った|スクショ|本文|会話|LINE/i.test(text);
}
