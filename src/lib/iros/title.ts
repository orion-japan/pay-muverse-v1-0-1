// src/lib/iros/title.ts
// Iros — title suggester（短い会話用タイトル生成）
// 依存なし。buildPrompt / wire.orchestrator から呼ばれます。

export type FocusLite = {
  phase?: string; // 'Inner' | 'Outer'
  depth?: string; // 'S1'..'I3'
  q?: string;     // 'Q1'..'Q5'
};

export type MemoryLite = {
  summary?: string;
  keywords?: string[];
} | null;

/** 日本語テキストから簡易タイトルを抽出（先頭文の名詞句ベース） */
function extractHeadPhrase(text: string): string {
  const t = String(text ?? '').trim();

  if (!t) return '';

  // 1) 改行で先頭段落を取る
  const para = t.split(/\n+/)[0] || t;

  // 2) 区切り（句点・？・！）で最初の文
  const first = (para.split(/(?<=[。．!?！？])/)[0] || para).trim();

  // 3) 不要助詞や読点の末尾を除去
  let s = first.replace(/[。．!?！？]+$/u, '').trim();

  // 4) 余分な接頭（「相談」「質問です」など）の軽い除去
  s = s
    .replace(/^相談(です|したい|があります)?/u, '')
    .replace(/^質問(です|したい|があります)?/u, '')
    .replace(/^お願い(です|したい)?/u, '')
    .replace(/^助けてください/u, '')
    .trim();

  // 5) 先頭の「私は/自分は/今日」は削る
  s = s.replace(/^(私は|自分は|今日は|今は)\s*/u, '').trim();

  // 6) 20〜28文字程度に丸める
  const MAX = 28;
  if (s.length > MAX) s = s.slice(0, MAX);

  // 空ならフォールバック
  return s || '会話のメモ';
}

function labelFromFocus(f?: FocusLite): string {
  if (!f) return '';
  const parts: string[] = [];
  if (f.q) parts.push(f.q);
  if (f.phase) parts.push(f.phase);
  if (f.depth) parts.push(f.depth);
  return parts.join('·');
}

/** タイトル候補を生成（テキスト先頭 + フォーカスラベル + キーワード1） */
export function makeTitle(
  userText: string,
  focus?: FocusLite | null,
  memory?: MemoryLite | undefined,
): string {
  const head = extractHeadPhrase(userText);
  const lab = labelFromFocus(focus ?? undefined);
  const kw =
    (memory?.keywords && memory.keywords.find((k) => k && k.length <= 10)) ||
    (memory?.summary ? memory.summary.split(/[、, ]/)[0] : '') ||
    '';

  const parts = [head, lab, kw].map((p) => String(p || '').trim()).filter(Boolean);

  // 先頭優先で 16〜28 文字に収める
  let title = parts.join(' | ').trim();
  const MAX = 28;
  if (title.length > MAX) title = title.slice(0, MAX);

  // 最終フォールバック
  return title || '会話のメモ';
}

export default { makeTitle };
