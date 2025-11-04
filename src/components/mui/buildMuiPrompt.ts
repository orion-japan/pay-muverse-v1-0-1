/* =========================================================
 *  buildMuiPrompt.ts
 *  OCRテキストから要約・整形プロンプトを生成
 * ========================================================= */

export type Mode = 'verbatim' | 'short' | 'normal' | 'deep';

/**
 * OCRテキストとモードからプロンプトを生成
 */
export function buildMuiPrompt(ocrAll: string, mode: Mode): string {
  const baseLen = ocrAll.replace(/\s/g, '').length;
  const minVerbatim = Math.max(Math.floor(baseLen * 0.85), 600);
  const minShort = 300;
  const minNormal = Math.max(600, Math.floor(baseLen * 0.6));
  const minDeep = Math.max(900, Math.floor(baseLen * 0.75));

  if (mode === 'verbatim') {
    return `
あなたは編集者です。以下のOCRテキストを**内容を省略せずに忠実に整形**してください。
- 誤字脱字や改行を整える
- 明らかな広告やヘッダーなどのノイズは削除
- 段落を自然に構成し直す
- **${minVerbatim}文字以上**にしてください
- 省略禁止／要約禁止
- 出力はMarkdown形式で

## 整形テキスト
${ocrAll}`.trim();
  }

  const lenRule =
    mode === 'short'
      ? `本文は**${minShort}文字以上**`
      : mode === 'normal'
        ? `本文は**${minNormal}文字以上**`
        : `本文は**${minDeep}文字以上**`;

  const rigor =
    mode === 'deep'
      ? '因果・心理・具体策を含み、抽象的で終わらないように。'
      : mode === 'normal'
        ? '相談の要点と対話の背景を明確に。'
        : '簡潔に要点をまとめてください。';

  return `
あなたは恋愛相談の要約編集者です。以下のOCRテキストを${rigor}
- ${lenRule}
- 出力はMarkdown形式
- 構造を必ず含む：
  ## 概要
  ## 状況と心理
  ## 今後の提案
  ## 送信用下書き（200〜300字）

--- OCR ---
${ocrAll}`.trim();
}
