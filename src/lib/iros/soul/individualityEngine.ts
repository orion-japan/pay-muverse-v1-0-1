// src/lib/iros/soul/individualityEngine.ts
// 個性 → 役割リフレームを iros_soul で使うためのユーティリティ

import { IROS_SOUL_INDIVIDUALITY_V1 } from './individuality';

export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

export type IndividualityCategory =
  | 'emotion'
  | 'cognition'
  | 'behavior'
  | 'social'
  | 'identity';

export interface IndividualityReframe {
  category: IndividualityCategory;
  trait: string;
  meaning: string;
}

export interface SoulIndividualityResult {
  trait: string;
  meaning: string;
  // 「どう受け止めるか」「どう声をかけるか」
  soul_view: string;
  suggestion: string;
}

/**
 * trait 名（「怖がり」「完璧主義」など）から
 * individuality辞書上の定義を引く。
 */
export function findReframeByTrait(trait: string): IndividualityReframe | null {
  const t = trait.trim();
  if (!t) return null;

  const entry = IROS_SOUL_INDIVIDUALITY_V1.reframes.find(
    (r) => r.trait === t
  );

  return entry ?? null;
}

/**
 * 簡易版：
 * ユーザーのテキストに含まれる「自己ラベル」から、
 * individuality辞書の trait を推定するためのキーワードマッチ。
 *
 * 例：
 *   text: 「自分は本当に怖がりで…」
 *   → 「怖がり」を検出して reframe。
 *
 * ※ 精度を上げたい場合は、
 *   ここを後から LLM／ルールで差し替えればOK。
 */
export function detectTraitsFromText(text: string): string[] {
  const normalized = text.replace(/\s+/g, '');
  const traits: string[] = [];

  for (const entry of IROS_SOUL_INDIVIDUALITY_V1.reframes) {
    if (normalized.includes(entry.trait)) {
      traits.push(entry.trait);
    }
  }

  // 重複排除
  return Array.from(new Set(traits));
}

/**
 * Qコードに応じた、やさしめの一文のトーンを決める。
 * （細かい文言は必要に応じて後で調整可能）
 */
function buildTonePrefixByQ(q?: QCode): string {
  switch (q) {
    case 'Q1':
      return 'ちゃんとしなきゃ、と自分に厳しくなりがちかもしれませんが、';
    case 'Q2':
      return '変えたい、良くしたいという思いが強いからこそ、';
    case 'Q3':
      return 'いろいろ不安になりながらも、それでも進もうとしているからこそ、';
    case 'Q4':
      return '手放したいものや、流したい感情がたくさんある中で、';
    case 'Q5':
      return '何も感じたくない・動きたくないような重さの中でも、';
    default:
      return 'これまでのあなたの歩みを見ていると、';
  }
}

/**
 * individuality 辞書をもとに、
 * iros_soul としての「受け止め」と「一言メッセージ」を生成する。
 *
 * - trait: ユーザーが自分で言ったラベル（例：「怖がり」「完璧主義」など）
 * - q: そのときの Qコード（雰囲気のトーン調整に使用）
 */
export function buildSoulIndividualityMessage(
  trait: string,
  q?: QCode
): SoulIndividualityResult | null {
  const reframe = findReframeByTrait(trait);
  if (!reframe) return null;

  const prefix = buildTonePrefixByQ(q);

  const soul_view = `${prefix}その「${reframe.trait}」は、${
    reframe.meaning
  } として、ずっとあなたを守ってきた側面でもあるように感じます。`;

  const suggestion =
    `それを「直さなきゃいけない欠点」ではなく、` +
    `少しずつ「どう活かしていくか」を一緒に見ていけるといいですね。`;

  return {
    trait: reframe.trait,
    meaning: reframe.meaning,
    soul_view,
    suggestion,
  };
}

/**
 * テキストから trait を検出し、
 * 最初に見つかったものについて
 * iros_soul 用のメッセージを返すヘルパー。
 *
 * - unified の中で「ユーザーが自分をどうラベリングしているか」が
 *   まだ取れていない段階の簡易実装として使える。
 */
export function analyzeTextAndBuildSoulMessage(
  text: string,
  q?: QCode
): SoulIndividualityResult | null {
  const traits = detectTraitsFromText(text);
  if (traits.length === 0) return null;

  return buildSoulIndividualityMessage(traits[0], q);
}

// 個性リフレームを、soulの返答テキストに合成するヘルパー
// - userText: ユーザーが送ってきたテキスト（元メッセージ）
// - q: そのターンでの Qコード（なくてもOK）
// - baseSoulText: すでに組み立て済みの「soul側の返答」本文
//
// 戻り値: individuality が検出されれば、それを末尾に足したテキスト。
//         検出されなければ baseSoulText のまま返す。


export function enrichSoulReplyWithIndividuality(
  userText: string,
  q: QCode | undefined,
  baseSoulText: string
): string {
  const individuality = analyzeTextAndBuildSoulMessage(userText, q);

  if (!individuality) {
    console.log('[IROS/Individuality] no trait detected in text', { userText });
    return baseSoulText;
  }

  console.log('[IROS/Individuality] detected trait', {
    trait: individuality.trait,
    q,
  });

  const extra =
    '\n\n---\n' +
    `${individuality.soul_view}\n` +
    `${individuality.suggestion}`;

  return baseSoulText + extra;
}

