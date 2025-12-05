// src/lib/iros/soul/shouldUseSoul.ts
// Iros 魂LLMを起動するかどうかを判定するヘルパー
// - Qコード / SA / Y / H から「難しい帯域」を検出する
// - ここはあくまで暫定のしきい値ロジックとしておき、実運用しながら調整する想定

import type { QCode } from '../system';
import type { IrosSoulInput } from './types';

// 魂を優先的に起動したい Q 帯域
const SOUL_Q_CODES: QCode[] = ['Q2', 'Q3', 'Q4', 'Q5'];

/**
 * Iros 魂を回すかどうかの判定
 *
 * 方針（レポートの内容をコード化）：
 * - Q2〜Q5 の「難しい帯域」を中心に、SA/Y/H の条件を満たしたときだけ起動
 * - 特に Q5（うつ寄り）は、原則として必ず起動
 * - Qコードが取れていなくても、SA がかなり低く Y 高・H 低なら起動
 */
export function shouldUseSoul(input: IrosSoulInput): boolean {
  const { qCode, selfAcceptance: sa, yLevel: y, hLevel: h } = input;

  // ---- 1) Qコードの帯域判定 ----------------------------------------

  const isSoulBandQ = qCode != null && SOUL_Q_CODES.includes(qCode);

  const isQ5 = qCode === 'Q5'; // うつ / 空虚 帯域 → 原則 魂を必ず起動

  // ---- 2) SA / Y / H のしきい値 ------------------------------------

  // SA が低め（自己否定が強くなりやすいライン）
  const saLow = typeof sa === 'number' && sa < 0.45;

  // 揺れが強い（感情の波が大きい）
  const strongShake = typeof y === 'number' && y >= 0.6;

  // 余白が少ない（キャパが少なく、情報を詰め込みにくい）
  const lowMargin = typeof h === 'number' && h <= 0.35;

  // ---- 3) 組み合わせロジック --------------------------------------

  // ✅ Q5 帯域なら、基本的に必ず魂を起動
  if (isQ5) {
    return true;
  }

  // ✅ Q2〜Q4 で、かつ SA低 or 揺れ大 or 余白少 → 魂を起動
  if (isSoulBandQ && (saLow || strongShake || lowMargin)) {
    return true;
  }

  // ✅ Qコードが取れていなくても、
  //    SAがかなり低く、揺れが強い or 余白が少ない場合は魂でセーフティをかける
  if (!qCode && saLow && (strongShake || lowMargin)) {
    return true;
  }

  // それ以外は、通常は魂を回さない（本体のみで処理）
  return false;
}
