// src/lib/iros/language/softExpression.ts

export function applySoftExpression(text: string): string {
  if (!text) return text;

  let t = text;

  // ----------------------------------------
  // ① 構造語 → やさしい言い回しに変換
  // ----------------------------------------
  const replacements: Array<[RegExp, string]> = [
    [/通路が立っていない/g, 'まだ通れそうな流れになってない感じがある'],
    [/閉じている/g, '少し閉じる方向に寄ってる感じがある'],
    [/逆流している/g, '進もうとすると少し戻される感じがある'],
    [/未通過/g, 'まだ通れていない状態に近い'],
    [/構造的には/g, '見ていくと'],
    [/状態である/g, '感じに近い'],
  ];

  for (const [pattern, replacement] of replacements) {
    t = t.replace(pattern, replacement);
  }

  // ----------------------------------------
  // ③ 長さを少しだけ増やす（説明なし）
  // ----------------------------------------
  // → 文を分割して“滞在感”を作る
  t = t
    .replace(/。/g, '。\n')
    .replace(/\n{2,}/g, '\n');

  // ----------------------------------------
  // ④ 断定を少しだけ緩める
  // ----------------------------------------
  t = t
    .replace(/である/g, '気がする')
    .replace(/と言える/g, 'ように見える');

  return t.trim();
}
