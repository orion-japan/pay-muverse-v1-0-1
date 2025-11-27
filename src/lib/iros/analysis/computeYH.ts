// src/lib/iros/analysis/computeYH.ts
// 揺れ(Y)・余白(H) を推定するコアロジック
// - いまは簡易ルールベース
// - 将来 LLM ベースに差し替えるときも、このモジュールの中だけで完結させる想定

import type { Depth, QCode } from '../system';
import type { UnifiedLikeAnalysis } from '../unifiedAnalysis';
import type { HLevel, YLevel, IrosTurnMeta } from '../types';

export type ComputeYHInput = {
  /** ユーザーの今回の発話（履歴digest込みでもよい） */
  text: string;

  /** Orchestrator で決定した最終 depth / qCode（あれば） */
  depth?: Depth | string | null;
  qCode?: QCode | string | null;

  /** meta.selfAcceptance などから渡される SA（0.0〜1.0） */
  selfAcceptance?: number | null;

  /** Unified-like 解析結果（phase などを参照したいとき用） */
  unified?: UnifiedLikeAnalysis | null;

  /** 直前ターンの meta など、参考にしたい情報があれば */
  prevMeta?: Partial<IrosTurnMeta> | null;
};

export type ComputeYHResult = {
  yLevel: YLevel;
  hLevel: HLevel;
};

/**
 * メイン入口
 * - text / depth / qCode / selfAcceptance から Y/H を決める
 * - いまはシンプルなルールベース
 */
export function computeYH(input: ComputeYHInput): ComputeYHResult {
  const { text, depth, qCode, selfAcceptance, unified, prevMeta } = input;

  const normalizedText = (text ?? '').trim();
  const sa = normalizeSA(selfAcceptance ?? unified?.selfAcceptance ?? null);

  const yScore = clamp0to3(
    scoreYFromText(normalizedText) +
      scoreYFromQ(qCode) +
      scoreYFromDepth(depth) +
      scoreYFromSA(sa) +
      scoreYFromPrev(prevMeta),
  );

  const hScore = clamp0to3(
    scoreHFromText(normalizedText) +
      scoreHFromSA(sa) +
      scoreHFromDepth(depth) +
      scoreHFromPrev(prevMeta),
  );

  return {
    yLevel: yScore as YLevel,
    hLevel: hScore as HLevel,
  };
}

/* ========= 内部ヘルパー ========= */

function clamp0to3(value: number): 0 | 1 | 2 | 3 {
  if (Number.isNaN(value)) return 1;
  if (value < 0) return 0;
  if (value > 3) return 3;
  return value as 0 | 1 | 2 | 3;
}

function normalizeSA(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * テキストから揺れ(Y)をスコアリング
 * - 強い感情語・「どうしよう」「やばい」系が多いほど +α
 */
function scoreYFromText(text: string): number {
  if (!text) return 0;

  let score = 0;

  // 強い否定・切迫
  if (/[最悪]|もうだめ|無理|限界|しんどい|つらい|死にたい|消えたい/.test(text)) {
    score += 2;
  }

  // 不安・迷い
  if (/(どうしよう|不安|怖い|こわい|心配|焦り|焦ってる|モヤモヤ|もやもや)/.test(text)) {
    score += 1;
  }

  // 疑問・反芻
  const questionMarks = (text.match(/[？?]/g) || []).length;
  if (questionMarks >= 2) {
    score += 1;
  }

  // 強い感嘆
  const exclamations = (text.match(/[！!]/g) || []).length;
  if (exclamations >= 2) {
    score += 0.5;
  }

  // 長文で感情語が散らばっている場合は少しだけ加算
  if (text.length > 200 && /(どう|なぜ|本当に|マジで)/.test(text)) {
    score += 0.5;
  }

  return score;
}

/**
 * Qコードから揺れ(Y)をスコアリング
 * - Q2/Q3/Q4 は揺れが出やすい
 * - Q1/Q5 は揺れが抑圧 or 空虚化されている可能性として少しだけ加算
 */
function scoreYFromQ(qCode: QCode | string | null | undefined): number {
  if (!qCode) return 0;
  const q = String(qCode);

  if (q === 'Q2' || q === 'Q3' || q === 'Q4') {
    return 1.0;
  }
  if (q === 'Q1' || q === 'Q5') {
    return 0.5;
  }
  return 0;
}

/**
 * Depth から揺れ(Y)をスコアリング
 * - S層/R層/C層：通常レベル
 * - I層：揺れが大きく感じられやすいので少し加算
 */
function scoreYFromDepth(depth: Depth | string | null | undefined): number {
  if (!depth) return 0;
  const d = String(depth);

  if (d.startsWith('I')) {
    return 0.5;
  }
  return 0;
}

/**
 * SelfAcceptance から揺れ(Y)をスコアリング
 * - SAが低いほど揺れが大きいとみなす
 */
function scoreYFromSA(sa: number | null): number {
  if (sa == null) return 0;

  if (sa < 0.2) return 1.5;
  if (sa < 0.4) return 1.0;
  if (sa < 0.6) return 0.5;
  return 0;
}

/**
 * 直前ターンのメタから揺れ(Y)を補正
 * - すでに high に近い yLevel が続いていれば、少しだけ補強
 */
function scoreYFromPrev(prevMeta?: Partial<IrosTurnMeta> | null): number {
  if (!prevMeta) return 0;
  const prevY = prevMeta.yLevel;
  if (prevY == null) return 0;

  if (prevY >= 3) return 0.5;
  if (prevY === 2) return 0.25;
  return 0;
}

/**
 * テキストから余白(H)をスコアリング
 * - 「時間がない」「追い詰められている」系は H を下げる方向
 * - 逆に「ゆっくり」「考えたい」などは H を少し上げる
 */
function scoreHFromText(text: string): number {
  if (!text) return 1; // 何もなければ普通レベル

  let score = 1; // ベースを 1（やや余白あり）にしておく

  if (
    /(時間がない|締め切り|デッドライン|間に合わない|追い詰められてる|いっぱいいっぱい|余裕がない)/.test(
      text,
    )
  ) {
    score -= 1;
  }

  if (/(少し考えたい|ゆっくり|一旦|いったん|落ち着いて|整理したい)/.test(text)) {
    score += 0.5;
  }

  return score;
}

/**
 * SAから余白(H)をスコアリング
 * - SAが高いほど「内的な余白」があるとみなす
 */
function scoreHFromSA(sa: number | null): number {
  if (sa == null) return 0;

  if (sa < 0.2) return -1.0;
  if (sa < 0.4) return -0.5;
  if (sa < 0.6) return 0;
  if (sa < 0.8) return 0.5;
  return 1.0;
}

/**
 * Depth から余白(H)をスコアリング
 * - C/I 層は「概念的な余白」が広がりやすいイメージで少し加算
 */
function scoreHFromDepth(depth: Depth | string | null | undefined): number {
  if (!depth) return 0;
  const d = String(depth);

  if (d.startsWith('C') || d.startsWith('I')) {
    return 0.25;
  }
  return 0;
}

/**
 * 直前ターンから余白(H)を補正
 * - 直前が very narrow / very wide の場合、いきなり大きくは変わりにくい前提で小さく補正
 */
function scoreHFromPrev(prevMeta?: Partial<IrosTurnMeta> | null): number {
  if (!prevMeta) return 0;
  const prevH = prevMeta.hLevel;
  if (prevH == null) return 0;

  if (prevH >= 3) return 0.25;
  if (prevH === 0) return -0.25;
  return 0;
}
