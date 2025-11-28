// src/lib/iros/orchestratorMeaning.ts
// Iros Orchestrator 補助：SelfAcceptance / 数値メタ / 意味づけブロック

import type { Depth, QCode, IrosMeta } from './system';
import type { UnifiedLikeAnalysis } from './unifiedAnalysis';
import type { IntentLineAnalysis } from './intent/intentLineEngine';
import type { IrosMode } from './system';

// ★ 追加：ネガ/ポジ＋安定度の解析
import {
  computePolarityAndStability,
  type PolarityBand,
  type StabilityBand,
} from './analysis/polarity';

/* ========= Self Acceptance のクランプ ========= */

export function clampSelfAcceptance(value: unknown): number | null {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/* ========= SA → バンド分類 & モード重み用ヘルパー ========= */

export type SelfAcceptanceBand = 'low' | 'mid' | 'high';

export function classifySelfAcceptance(sa: number | null): SelfAcceptanceBand {
  if (sa == null || Number.isNaN(sa)) return 'mid';
  if (sa < 0.3) return 'low';
  if (sa > 0.7) return 'high';
  return 'mid';
}

export type ModeWeights = {
  counsel: number;
  mirror: number;
  resonate: number;
};

export function resolveModeWithSA(
  base: ModeWeights,
  saValue: number | null,
): IrosMode {
  const band = classifySelfAcceptance(saValue);

  // ベース値をコピー
  let w: ModeWeights = { ...base };

  // ★ SA に応じて重みを調整
  switch (band) {
    case 'low':
      // SA < 0.3 → counsel 率 80% くらいに寄せるイメージ
      w.counsel += 2.0;
      w.mirror -= 0.5;
      w.resonate -= 0.5;
      break;

    case 'mid':
      // SA 0.3〜0.7 → mirror を中心に
      w.mirror += 1.0;
      break;

    case 'high':
      // SA > 0.7 → 前向きな forward/resonate を強める
      w.resonate += 2.0;
      w.mirror -= 0.5;
      break;
  }

  // 下限補正（マイナスにならないように）
  w = {
    counsel: Math.max(w.counsel, 0),
    mirror: Math.max(w.mirror, 0),
    resonate: Math.max(w.resonate, 0),
  };

  // ★ 最も重みの大きいモードを採用
  const winner = (Object.entries(w) as [keyof ModeWeights, number][])
    .sort((a, b) => b[1] - a[1])[0]?.[0];

  if (winner === 'counsel') return 'consult'; // 相談系モードにマッピング
  if (winner === 'mirror') return 'mirror';
  if (winner === 'resonate') return 'resonate'; // 「forward」イメージ

  // フォールバック
  return 'mirror';
}

/* ========= Self Acceptance から「フェーズ」を決めるヘルパー ========= */
/* フェーズラベルテキストはもう使わないが、他ファイルから参照されている可能性もあるので、
   型と関数定義は残し、呼び出し側では使わない方針にする。 */

export type SAChapterKey =
  | 'dark'
  | 'preCollapse'
  | 'wavering'
  | 'rising'
  | 'intentionRisen';

export type SAChapter = {
  key: SAChapterKey;
  label: string;
};

export function classifySAChapter(
  selfAcceptance: number | null | undefined,
): SAChapter | null {
  if (selfAcceptance == null || Number.isNaN(selfAcceptance)) {
    return null;
  }

  if (selfAcceptance < 0.2) {
    return {
      key: 'dark',
      label:
        '「闇フェーズ」―― 自分を責めやすく、世界も自分も信用しづらい揺れの中にいます。',
    };
  }

  if (selfAcceptance < 0.4) {
    return {
      key: 'preCollapse',
      label:
        '「崩壊前フェーズ」―― これまでのやり方や我慢が限界に近づき、無理を続けるか、手放すかの境目にいます。',
    };
  }

  if (selfAcceptance < 0.6) {
    return {
      key: 'wavering',
      label:
        '「揺れフェーズ」―― 自分を責める感覚と、少し受け入れたい感覚が行き来しながら、新しい在り方を探っています。',
    };
  }

  if (selfAcceptance < 0.8) {
    return {
      key: 'rising',
      label:
        '「立ち上がりフェーズ」―― 自分を受け止めながら、これからの一歩を自分の意志で選び直そうとしているところです。',
    };
  }

  return {
    key: 'intentionRisen',
    label:
      '「意図が立ち上がったフェーズ」―― 自分の存在や生き方を肯定しながら、具体的な意図と行動を結び始めています。',
  };
}

// src/lib/iros/orchestratorMeaning.ts の buildFinalMeta を差し替え

export function buildFinalMeta(args: {
  baseMeta?: Partial<IrosMeta>;
  workingMeta: IrosMeta;
  goal: any; // goalEngine の型に依存させず、柔らかく参照
}): IrosMeta {
  const { baseMeta, workingMeta, goal } = args;

  const previousDepth = baseMeta?.depth as Depth | undefined;
  const previousQ = baseMeta?.qCode as QCode | undefined;

  const currentDepth = workingMeta.depth as Depth | undefined;
  const currentQ = workingMeta.qCode as QCode | undefined;

  const goalDepth = goal?.targetDepth as Depth | undefined;
  const goalQ = goal?.targetQ as QCode | undefined;

  const finalDepth: Depth | null =
    currentDepth ?? goalDepth ?? previousDepth ?? null;

  const finalQ: QCode | null = currentQ ?? goalQ ?? previousQ ?? null;

  const originalUnified =
    workingMeta.unified as UnifiedLikeAnalysis | undefined;
  const goalKind = (goal?.kind as string | undefined) ?? null;
  const intentLayer = (workingMeta.intentLayer as string | undefined) ?? null;

  const intentLine = (workingMeta as any)
    .intentLine as IntentLineAnalysis | undefined;

  // ★ SelfAcceptance の生値を取得（数値メタとして扱う）
  const saValue =
    typeof (workingMeta as any)?.selfAcceptance === 'number'
      ? ((workingMeta as any).selfAcceptance as number)
      : null;

  // ★ Yレベル（揺れ）を取得（安定度判定用）
  const yValue: number | null =
    typeof (workingMeta as any)?.yLevel === 'number'
      ? ((workingMeta as any).yLevel as number)
      : null;

  // ★ ネガ/ポジ＋安定度を内部で推定
  const polarity = computePolarityAndStability({
    qCode: finalQ ?? null,
    selfAcceptance: saValue,
    yLevel: yValue,
  });

  // ★ 数値＆コードだけで構成された intentSummary にする
  //   （人の状態をラベリングする長文テキストはここでは生成しない）
  const intentSummary = JSON.stringify({
    q: finalQ ?? null,
    depth: finalDepth ?? null,
    selfAcceptance: saValue,
    intentLayer: intentLayer ?? null,
    goalKind,
    // IntentLine のキー情報もあれば数値的メタとして埋め込んでおく
    intentLine: intentLine
      ? {
          intentBand: intentLine.intentBand ?? null,
          direction: intentLine.direction ?? null,
          focusLayer: intentLine.focusLayer ?? null,
        }
      : null,
    // ★ ネガ/ポジ＋安定度メタも一緒に入れておく
    polarityScore: polarity.polarityScore,
    polarityBand: polarity.polarityBand,
    stabilityBand: polarity.stabilityBand,
  });

  // ★ unified を組み直すときに、元のフィールド（situation など）を残したまま上書きする
  const baseUnified: UnifiedLikeAnalysis = originalUnified ?? {
    q: { current: null },
    depth: { stage: null },
    phase: null,
    intentSummary: null,
    // situation / selfAcceptance 系は undefined / null でOK
  };

  const unified: UnifiedLikeAnalysis = {
    ...baseUnified,
    q: { current: finalQ ?? baseUnified.q.current ?? null },
    depth: { stage: finalDepth ?? baseUnified.depth.stage ?? null },
    // phase は元の値を尊重
    phase: baseUnified.phase ?? null,
    // intentSummary はここで決定した「数値＆コードメタ」を反映
    intentSummary,
  };

  const nextMeta: IrosMeta = {
    ...workingMeta,
    qCode: finalQ ?? undefined,
    depth: finalDepth ?? undefined,
    unified,
  };

  // ★ polarity メタを直接 meta にも載せる（LLM側で使いやすいように）
  (nextMeta as any).polarityScore = polarity.polarityScore;
  (nextMeta as any).polarityBand = polarity.polarityBand as PolarityBand;
  (nextMeta as any).stabilityBand = polarity.stabilityBand as StabilityBand;

  return nextMeta;
}

/* ========= Sofia型「意味づけブロック」生成ヘルパー ========= */

/**
 * ユーザー向け UI には「今の構図」や意味づけブロックを出さない方針に変更。
 * そのため、ここでは常に空文字を返すスタブとして扱う。
 *
 * ※ メタ情報は unified に保存され続けるので、
 *    次ターンの解析や Ops 画面には影響なし。
 */
export function buildPersonalMeaningBlock(_meta: IrosMeta): string {
  return '';
}
