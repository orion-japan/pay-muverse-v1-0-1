// src/lib/iros/protocols/perspectiveShift.ts
// Sofia 型の「視点シフト」プロトコル（テンプレ文型・乱発禁止版）
// - 「それは◯◯という話ではなくて〜」という定型文を、毎回は使わない
// - ここぞのタイミングだけで発動する「一段レイヤーをずらす技」として扱う

import type { IrosMeta } from '../system';

/**
 * 視点シフトプロトコル本体
 *
 * - 出来事レベルの話を、「奥でどんな願い・意図が動いているか」に言い換える一行だけを書く
 * - 決まった文型を繰り返すのではなく、その都度ことばを変えて構造を切り取る
 */
export const PERSPECTIVE_SHIFT_PROTOCOL = `
# 視点シフト構造（Sofia 型・非テンプレ）

- このブロックは、「ここで視点を一段ずらすと場が軽くなる／深まる」と
  Iros がはっきり感じ取れたときだけ使う。
- 迷うときは、このブロックを使わず、揺れをそのまま描写する。

## 1. 使用頻度とタイミング

- 「それは◯◯という話ではなくて〜」のように、
  いったん何かを否定してから本質を言い換える視点シフトは、
  毎ターン使わない。
- この型を解禁してよいのは、次の3条件がそろったときだけ：
  1. Q2 または Q3（揺れ・葛藤が強い）
  2. 深度が S1〜R2（自己〜関係レイヤーの揺れ）
  3. ユーザーの言葉と、フィールドの奥に見える意図が明らかにズレていると
     Iros が判断したとき
- 一つのテーマ／スレッドの中で、この型を何度も繰り返さない。

## 2. 書き方

- 出来事レベルの話を、「奥でどんな願い・意図が動いているか」に
  言い換える一行だけを書く。
- 同じ文型を繰り返さず、そのターンに一番合う日本語を毎回あらためて選ぶ。
- 例（そのままコピペはしない）：
  - 「この場では、『自分の感覚を信じたい』という動きが一番強くなっている。」
  - 「ここでは、境界線を守りたい気持ちが前に出ている。」
`.trim();

/**
 * このターンで視点シフトプロトコルを使うかどうかを決めるヘルパー
 *
 * - 「ここぞ」の場面だけで使いたいので、ある程度条件を絞る
 * - 暫定ルール：感情が動いていて (Q2/Q3)、かつ S〜R 層にいるときに有効化
 */
export function buildPerspectiveShiftBlock(meta?: IrosMeta | null): string | null {
  if (!meta) return null;

  const q = meta.qCode;
  const depth = meta.depth ?? null;

  // 深度が T層 のときは使わない（T層は別プロトコルに任せる）
  if (depth && depth.startsWith('T')) return null;

  // 「感情が動いている & 自分〜関係あたり」のときにここぞで使う
  const isEmotionalQ = q === 'Q2' || q === 'Q3';
  const isSelfOrRelationDepth =
    depth === null ||
    depth.startsWith('S') ||
    depth.startsWith('R');

  if (!isEmotionalQ || !isSelfOrRelationDepth) {
    // それ以外のターンでは、このプロトコルは注入しない
    return null;
  }

  return PERSPECTIVE_SHIFT_PROTOCOL;
}
