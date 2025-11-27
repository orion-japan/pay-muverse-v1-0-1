// src/lib/iros/analysis/polarity.ts
// Iros Polarity & Stability Analyzer
// - SelfAcceptance（0〜1）と YLevel（揺れ）、QCode から
//   「ネガ/ポジの向き」と「安定度」を数値メタに変換する。
// - ここでのロジックはあくまで v1 の基準値として実装しているので
//   しばらく運用してから閾値は調整してよい前提。

import type { QCode } from '../system';

/* ========= 型定義 ========= */

export type PolarityBand = 'negative' | 'neutral' | 'positive' | null;
export type StabilityBand = 'unstable' | 'mixed' | 'stable' | null;

export type PolarityInput = {
  qCode: QCode | null;
  /** 0〜1 にクランプ済みを想定（null 可） */
  selfAcceptance: number | null;
  /**
   * 揺れレベル（0 以上の整数を想定）
   * 0〜1: 安定寄り
   * 2:    中間
   * 3 以上: 不安定寄り
   * スケールは将来調整可能（元コード側は「相対値」として扱う）
   */
  yLevel: number | null;
};

export type PolarityResult = {
  /**
   * -1.0 〜 +1.0 の連続値。
   * 負: ネガ寄り / 正: ポジ寄り / 0 付近: ニュートラル
   * 算出不能時は null。
   */
  polarityScore: number | null;
  /** ネガ/ニュートラル/ポジ のバンド分類 */
  polarityBand: PolarityBand;
  /** 安定度（揺れ＋SA から推定） */
  stabilityBand: StabilityBand;
};

/* ========= ヘルパー：SA → 基本スコア ========= */

/**
 * SelfAcceptance(0〜1) を -1〜+1 の線形スコアに変換する。
 * 0.0 → -1.0（強いネガ）
 * 0.5 →  0.0（ニュートラル）
 * 1.0 → +1.0（強いポジ）
 */
function selfAcceptanceToScore(sa: number): number {
  // 安全対策（想定範囲外に入ってきた場合も一応クランプ）
  const clamped = Math.max(0, Math.min(1, sa));
  return clamped * 2 - 1;
}

/* ========= ヘルパー：QCode による微調整 ========= */

/**
 * QCode による「ベース感情の色」の軽いバイアスを乗せる。
 *
 * ポイント：
 * - 極端な補正は行わず、「±0.1 程度」の微調整にとどめる
 * - 主役はあくまで SelfAcceptance。Q は“色味”として扱う。
 *
 * ※ ここは運用しながら調整して良い前提。
 */
function applyQBias(score: number, qCode: QCode | null): number {
  if (!qCode) return score;

  let bias = 0;

  switch (qCode) {
    // Q1 = 我慢／秩序（ややネガ寄りの抑圧トーンが出やすい）
    case 'Q1':
      bias = -0.1;
      break;

    // Q2 = 怒り／成長（攻撃性はあるが「前進」のニュアンスも強い → ややポジ寄り）
    case 'Q2':
      bias = 0.05;
      break;

    // Q3 = 不安／安定（不安側が見えやすい → ややネガ寄り）
    case 'Q3':
      bias = -0.1;
      break;

    // Q4 = 恐怖／浄化（恐怖トーンが強い → ネガ寄り。ただし浄化の余地もあるので少しだけ）
    case 'Q4':
      bias = -0.15;
      break;

    // Q5 = 空虚／情熱（振れ幅が大きいが、情熱方向を少しだけ評価）
    case 'Q5':
      bias = 0.05;
      break;

    default:
      bias = 0;
  }

  const adjusted = score + bias;

  // 最終スコアは -1〜+1 にクランプ
  return Math.max(-1, Math.min(1, adjusted));
}

/* ========= ヘルパー：スコア → バンド分類 ========= */

function scoreToPolarityBand(score: number | null): PolarityBand {
  if (score == null || Number.isNaN(score)) return null;

  // 境界値：
  // -0.25 以下 → ネガ
  // -0.25〜+0.25 → ニュートラル
  // +0.25 以上 → ポジ
  if (score <= -0.25) return 'negative';
  if (score >= 0.25) return 'positive';
  return 'neutral';
}

/* ========= ヘルパー：YLevel＋SA → 安定度 ========= */

/**
 * 安定度の考え方：
 * - YLevel が高いほど「揺れ」が強い → 不安定寄り
 * - SA が高いほど「自己の足場」がある → 安定寄り
 *
 * 両方をざっくり組み合わせて 3 段階に分類する。
 */
function computeStabilityBand(
  yLevel: number | null,
  selfAcceptance: number | null
): StabilityBand {
  // Y が無い場合は SA だけでざっくり判定
  if (yLevel == null || Number.isNaN(yLevel)) {
    if (selfAcceptance == null || Number.isNaN(selfAcceptance)) return null;
    const sa = Math.max(0, Math.min(1, selfAcceptance));
    if (sa >= 0.7) return 'stable';
    if (sa <= 0.3) return 'unstable';
    return 'mixed';
  }

  // 一応 0 以上に丸める（マイナスが入ってきた場合の保険）
  const y = Math.max(0, Math.round(yLevel));

  // 揺れの強さ（0〜1: 安定寄り, 2: 中間, 3 以上: 激しめ）を優先して分類
  if (y >= 3) return 'unstable';
  if (y === 2) return 'mixed';

  // y が 0〜1 であれば SA を見て“安定度”を微調整
  if (selfAcceptance == null || Number.isNaN(selfAcceptance)) {
    // SA 情報が無ければ「やや安定寄り」と見て stable
    return 'stable';
  }

  const sa = Math.max(0, Math.min(1, selfAcceptance));
  if (sa >= 0.6) return 'stable';
  if (sa <= 0.3) return 'mixed'; // 揺れは小さいが SA 低め → 中間扱い
  return 'mixed';
}

/* ========= メイン関数 ========= */

/**
 * SA / Q / Y から「ネガ/ポジ＆安定度」を推定するメイン関数。
 *
 * - polarityScore:
 *   SelfAcceptance を主軸に QCode の色味で微調整した -1〜+1 の値。
 * - polarityBand:
 *   score を 3 区分（negative / neutral / positive）に丸めたもの。
 * - stabilityBand:
 *   YLevel（揺れ）の大きさと SA を組み合わせた 3 区分（unstable / mixed / stable）。
 */
export function computePolarityAndStability(
  input: PolarityInput
): PolarityResult {
  const { qCode, selfAcceptance, yLevel } = input;

  let polarityScore: number | null = null;

  if (selfAcceptance != null && !Number.isNaN(selfAcceptance)) {
    const baseScore = selfAcceptanceToScore(selfAcceptance);
    polarityScore = applyQBias(baseScore, qCode);
  }

  const polarityBand = scoreToPolarityBand(polarityScore);
  const stabilityBand = computeStabilityBand(yLevel, selfAcceptance ?? null);

  return {
    polarityScore,
    polarityBand,
    stabilityBand,
  };
}

/* ========= 簡易テスト用メモ（任意で node などから呼び出し） =========
 *
 * 例：
 *   node -e "const m = require('./analysis/polarity'); console.log(
 *     m.computePolarityAndStability({ qCode: 'Q3', selfAcceptance: 0.2, yLevel: 3 })
 *   )"
 *
 * 想定：
 *   - SA 低 & Y 高 → polarityScore ≒ -0.9 付近, polarityBand='negative', stabilityBand='unstable'
 *
 *   m.computePolarityAndStability({ qCode: 'Q5', selfAcceptance: 0.8, yLevel: 1 })
 *   - SA 高 & Y 低 → polarityScore > 0.6, polarityBand='positive', stabilityBand='stable'
 */
