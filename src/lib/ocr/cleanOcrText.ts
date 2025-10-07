// src/lib/ocr/cleanOcrText.ts
/**
 * OCR後テキストの軽整形
 */
export function cleanOcrText(s: string): string {
  return s
    .replace(/[ \t]+/g, ' ')
    .replace(/\u3000/g, ' ')
    .replace(/\s*([。！？…、，,.!?])/g, '$1')
    .replace(/([「『（(【])[ \t]*/g, '$1')
    .replace(/[ \t]*([」』）)】])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[^\x00-\x7Fぁ-んァ-ヶ一-龥ー。、！？…「」『』（）()・%〜\s-]/g, '') // 不明文字除去
    .trim();
}
