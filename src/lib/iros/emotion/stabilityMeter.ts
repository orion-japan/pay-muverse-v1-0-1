// src/lib/iros/emotion/stabilityMeter.ts
// Iros Emotion Stability Meter（LLM用の JSON 仕様 + パーサー）
// ※ このファイルは「型定義」と「パース処理」だけ。
//    実際の LLM 呼び出しは、別レイヤー（orchestrator や専用モジュール）で繋ぐ前提。

import type { QCode, Depth } from '../system';

/* ========= 型定義 ========= */

/** 感情の向き（ネガ/ニュートラル/ポジ） */
export type Polarity = 'negative' | 'neutral' | 'positive';

/** 安定度（low = 揺れが大きい / high = 安定度が高い） */
export type StabilityLevel = 'low' | 'high';

/** LLM に渡す入力構造 */
export type StabilityInput = {
  /** 今回のユーザー発話（必須） */
  userText: string;
  /** 直前の Iros 応答（あれば） */
  assistantText?: string;
  /** Iros が持っている Q コード（なくても可） */
  qCode: QCode | null;
  /** Iros が持っている depth（なくても可） */
  depthStage: Depth | null;
  /** 直近の自己受容度（0.0〜1.0 / なくても可） */
  selfAcceptance: number | null;
};

/** LLM から返ってくる素の JSON 期待値 */
export type StabilityRawJson = {
  polarity?: Polarity;
  stability?: StabilityLevel;
  /** 0〜1 のスコア（高いほど安定） */
  score?: number;
  /** 人間向けの簡単な理由（任意） */
  reason?: string | null;
};

/** Iros 内部で使う最終的な構造 */
export type StabilityResult = {
  polarity: Polarity;
  stability: StabilityLevel;
  /** 0〜1 にクランプ済み。解析失敗時は null */
  score: number | null;
  /** パース前の素の JSON（デバッグ用） */
  raw: StabilityRawJson | null;
  /** LLM 由来の説明テキスト（あれば） */
  reason: string | null;
};

/* ========= プロンプト生成 ========= */

/**
 * LLM に投げるときのシステム／ユーザープロンプトを組み立てる。
 * 実際の chatComplete 呼び出しは、別ファイル側で行う想定。
 */
export function buildStabilityPrompt(input: StabilityInput): string {
  const { userText, assistantText, qCode, depthStage, selfAcceptance } =
    input;

  const metaLines: string[] = [];
  if (qCode) metaLines.push(`- QCode: ${qCode}`);
  if (depthStage) metaLines.push(`- Depth: ${depthStage}`);
  if (typeof selfAcceptance === 'number') {
    metaLines.push(`- SelfAcceptance: ${selfAcceptance.toFixed(2)}`);
  }

  const metaBlock =
    metaLines.length > 0
      ? `【メタ情報（参考）】\n${metaLines.join('\n')}\n\n`
      : '';

  const assistantBlock = assistantText
    ? `【直前の Iros 応答】\n${assistantText}\n\n`
    : '';

  // ★ 出力は JSON オブジェクト 1つだけに限定
  return [
    'あなたは感情状態を評価するアナライザーです。',
    'ユーザーの発話内容とメタ情報をもとに、',
    '「感情の向き（ネガ/ニュートラル/ポジ）」と「安定度（low/high）」を推定してください。',
    '',
    '必ず、次の形式の JSON オブジェクトのみを返してください：',
    '',
    '{',
    '  "polarity": "negative" | "neutral" | "positive",',
    '  "stability": "low" | "high",',
    '  "score": 0〜1の数値,',
    '  "reason": "人間向けの短い説明"',
    '}',
    '',
    '余計な文章は一切書かず、JSON だけを返してください。',
    '',
    metaBlock,
    `【ユーザー発話】\n${userText}\n\n`,
    assistantBlock,
  ].join('\n');
}

/* ========= JSON パース処理 ========= */

export function parseStabilityJson(
  jsonText: string,
): StabilityResult {
  let raw: StabilityRawJson | null = null;

  try {
    raw = JSON.parse(jsonText) as StabilityRawJson;
  } catch {
    // 解析失敗時は raw=null のまま、下でデフォルト値を返す
    raw = null;
  }

  const polarity: Polarity = normalizePolarity(raw?.polarity);
  const stability: StabilityLevel = normalizeStability(raw?.stability);
  const score = clampScore(raw?.score);

  return {
    polarity,
    stability,
    score,
    raw,
    reason: raw?.reason ?? null,
  };
}

/* ========= 正規化ヘルパー ========= */

function normalizePolarity(value: any): Polarity {
  if (value === 'negative' || value === 'neutral' || value === 'positive') {
    return value;
  }
  // 解析失敗時は「neutral」に寄せる
  return 'neutral';
}

function normalizeStability(value: any): StabilityLevel {
  if (value === 'low' || value === 'high') {
    return value;
  }
  // 解析失敗時は安全側として「high（落ち着いている扱い）」にしない
  // → neutral寄りとして low に寄せておく
  return 'low';
}

function clampScore(value: any): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
