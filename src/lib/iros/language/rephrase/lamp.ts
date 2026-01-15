// src/lib/iros/language/rephrase/lamp.ts
// iros — lamp normalization helpers (🪔)

export function stripLampEverywhere(text: string): string {
  let t = String(text ?? '');

  // 単独行の🪔を削除
  t = t.replace(/^\s*🪔\s*$(\r?\n)?/gm, '');

  // 行末・末尾に付いた🪔を削除
  t = t.replace(/[ \t]*🪔[ \t]*$/gm, '');

  // "\n🪔\n" 形式を削除
  t = t.replace(/\n[ \t]*🪔[ \t]*(\n|$)/g, '\n');

  // “。”だけが残る事故（例：\n。\n🪔）の単独行を削除
  t = t.replace(/^\s*[。．\.]\s*$(\r?\n)?/gm, '');

  // 空行を整理
  t = t.replace(/\n{3,}/g, '\n\n').trimEnd();

  return t;
}

/**
 * renderEngine=true  のとき：🪔を絶対に出さない
 * renderEngine=false のとき：互換のため末尾🪔を1回だけ付ける
 */
export function finalizeLamp(text: string, renderEngine: boolean): string {
  const base = stripLampEverywhere(text);

  if (renderEngine) return base;

  const t = String(base ?? '').replace(/\r\n/g, '\n').trim();
  if (!t) return '🪔';

  // 末尾の🪔は1回に正規化
  const stripped = t.replace(/\n?🪔\s*$/u, '').trimEnd();
  return stripped + '\n🪔';
}
