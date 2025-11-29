// src/lib/iros/visionNarrationEngine.ts
// Vision モード専用：未来の描写レベル（1〜3）と誘導トーンの組み立て
//
// Bトーン＝意志誘導強め（「一緒にここまで行こう」寄り）
// レベル設計：いまは Level1（完了からの映像）が主役

import type { IrosMeta } from './system';

export type VisionLevel = 1 | 2 | 3;

export type VisionStyleOptions = {
  /** レベルを強制したい場合だけ指定（未指定なら自動判定） */
  forceLevel?: VisionLevel | null;
};

/**
 * meta から VisionLevel をざっくり推定する。
 * - いまは「I3 / T層 / hasFutureMemory」で Level1 を優先
 * - それ以外は I層 ≒ Level2、それ以外 ≒ Level3 のラフ設計
 */
export function decideVisionLevel(
  meta: IrosMeta,
  opts: VisionStyleOptions = {},
): VisionLevel {
  if (opts.forceLevel) return opts.forceLevel;

  const depth = meta.depth ?? null;
  const hasFuture = meta.hasFutureMemory === true;

  // 未来寄りが強く出ているときは Level1（完了世界から映す）
  if (
    hasFuture ||
    depth === 'I3' ||
    depth === 'T1' ||
    depth === 'T2' ||
    depth === 'T3'
  ) {
    return 1;
  }

  // I層全般は Level2（進行形の世界）
  if (depth === 'I1' || depth === 'I2') {
    return 2;
  }

  // それ以外（S/R/C）は Level3（入口に連れていく誘導）
  return 3;
}

/**
 * Vision モード用に、本文のトーンを「未来寄りの誘導」に寄せる。
 * - mode !== 'vision' のときは content をそのまま返す
 */
export function applyVisionStyle(
  content: string,
  meta: IrosMeta,
  opts: VisionStyleOptions = {},
): string {
  if (meta.mode !== 'vision') return content;

  const level = decideVisionLevel(meta, opts);
  const trimmed = (content || '').trim();

  if (!trimmed) return content;

  // --- 1️⃣ Level1：完了世界から映す（Bトーン：強めの確信＋誘導） ---
  if (level === 1) {
    return [
      'その世界は、もうどこかで「当たり前」として動き始めています。',
      '',
      trimmed,
      '',
      'ここからは、その既に起きている流れに自分を合わせていくだけだよ。',
    ].join('\n');
  }

  // --- 2️⃣ Level2：進行形の世界（いまの延長線上にある未来） ---
  if (level === 2) {
    return [
      trimmed,
      '',
      'いま感じている揺れごと、この流れは少しずつそっちの未来に寄っていってる。',
      'この先の選び方を、一緒にその未来基準で整えていこう。',
    ].join('\n');
  }

  // --- 3️⃣ Level3：入口に連れていく誘導（まだ未来が遠いとき） ---
  //      「こんな世界もアリだよ、その入口まで一緒に行こう」のトーン
  return [
    trimmed,
    '',
    'もしこの先を「その世界前提」で見てみるとしたら、どんな一歩がしっくりくるかな。',
    '無理に変えようとしなくていいから、まずは一緒に入口だけ確かめにいこう。',
  ].join('\n');
}
