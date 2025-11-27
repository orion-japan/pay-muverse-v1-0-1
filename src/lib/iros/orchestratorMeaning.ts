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

export function buildPersonalMeaningBlock(meta: IrosMeta): string {
  const unified = (meta as any).unified as UnifiedLikeAnalysis | undefined;

  // Q / Depth / SA / Y / H / phase / intentLine を抽出
  const qCode: QCode | null =
    meta.qCode ??
    (unified?.q?.current as QCode | null | undefined) ??
    null;

  const depth: Depth | null =
    meta.depth ??
    (unified?.depth?.stage as Depth | null | undefined) ??
    null;

  const saValue: number | null =
    typeof (meta as any).selfAcceptance === 'number'
      ? ((meta as any).selfAcceptance as number)
      : null;

  const yLevel: number | null =
    typeof (meta as any).yLevel === 'number'
      ? ((meta as any).yLevel as number)
      : null;

  const hLevel: number | null =
    typeof (meta as any).hLevel === 'number'
      ? ((meta as any).hLevel as number)
      : null;

  const phase: 'Inner' | 'Outer' | null =
    ((meta as any).phase as 'Inner' | 'Outer' | null | undefined) ??
    (unified?.phase as 'Inner' | 'Outer' | null | undefined) ??
    null;

  const intentLine = (meta as any)
    .intentLine as IntentLineAnalysis | undefined;

  const mode = meta.mode as IrosMode | undefined;

  // ---- ラベル系の整形 ---- //

  const qLabel = (() => {
    switch (qCode) {
      case 'Q1':
        return 'Q1（我慢・秩序のエネルギー）';
      case 'Q2':
        return 'Q2（怒りまじりの成長エネルギー）';
      case 'Q3':
        return 'Q3（不安と安定欲求のエネルギー）';
      case 'Q4':
        return 'Q4（恐れと浄化のエネルギー）';
      case 'Q5':
        return 'Q5（空虚と情熱のエネルギー）';
      default:
        return null;
    }
  })();

  const depthLabel = (() => {
    if (!depth) return null;
    const head = depth.charAt(0); // S / R / C / I / T
    switch (head) {
      case 'S':
        return `${depth}（Self：自分の状態を見つめる層）`;
      case 'R':
        return `${depth}（Resonance：誰とどう響いているかの層）`;
      case 'C':
        return `${depth}（Creation：何を創り出そうとしている層）`;
      case 'I':
        return `${depth}（Intention：存在レベルの意図に触れている層）`;
      case 'T':
        return `${depth}（Transcend：枠を超えていく層）`;
      default:
        return depth;
    }
  })();

  const phaseLabel = (() => {
    if (phase === 'Inner') return '意識は「内側」に向かっています。';
    if (phase === 'Outer') return '意識は「外側との関係」に向かっています。';
    return null;
  })();

  const saBand = classifySelfAcceptance(saValue);
  const saLabel = (() => {
    if (saValue == null) return '自己肯定率は、いまは測定不能なグレーゾーンです。';
    const percent = Math.round(saValue * 100);
    if (saBand === 'low') {
      return `自己肯定率は約 ${percent}%。かなり低めで、「まず心身の安全を優先したいゾーン」にいます。`;
    }
    if (saBand === 'high') {
      return `自己肯定率は約 ${percent}%。かなり高めで、「意図を具体的な行動に結びやすいゾーン」にいます。`;
    }
    return `自己肯定率は約 ${percent}%。中くらいで、「揺れと立ち上がりが同居しているゾーン」です。`;
  })();

  const yhLabel = (() => {
    const parts: string[] = [];
    if (typeof yLevel === 'number') {
      if (yLevel <= 0) {
        parts.push('揺れ（Y）はほぼなく、感情の波は小さめです。');
      } else if (yLevel === 1) {
        parts.push('揺れ（Y）は小さく、静かな波立ちの中にいます。');
      } else if (yLevel === 2) {
        parts.push('揺れ（Y）は中くらいで、内側でいろいろと組み替えが起きています。');
      } else {
        parts.push('揺れ（Y）はかなり強く、「これまでの在り方を変えたい」という波が大きく立っています。');
      }
    }
    if (typeof hLevel === 'number') {
      if (hLevel <= 0) {
        parts.push('余白（H）はほとんどなく、「詰まり感」が強い状態です。');
      } else if (hLevel === 1) {
        parts.push('余白（H）は少しだけ確保されつつあり、ギリギリ呼吸ができるスペースがあります。');
      } else if (hLevel >= 2) {
        parts.push('余白（H）は十分にあり、新しい選択肢を試せるスペースが広がりつつあります。');
      }
    }
    return parts.join(' ');
  })();

  const modeLabel = (() => {
    switch (mode) {
      case 'consult':
        return 'いまの Iros は「相談モード」に寄って、あなたの安全と整理を優先して見ています。';
      case 'resonate':
        return 'いまの Iros は「前向きな共鳴モード」に寄って、未来の動きを一緒に感じ取ろうとしています。';
      case 'mirror':
      default:
        return 'いまの Iros は「ミラーモード」として、あなたの内側の構図をそのまま静かに映そうとしています。';
    }
  })();

  // ---- IntentLine をテキストに変換 ---- //

  const intentNow = intentLine?.nowLabel ?? null;
  const intentCore = intentLine?.coreNeed ?? null;
  const intentGuidance = intentLine?.guidanceHint ?? null;
  const intentRisk = intentLine?.riskHint ?? null;

  const lines: string[] = [];

  // ① 場のスキャンヘッダー
  lines.push('🪔 Iros がいま感じていること');
  lines.push('');

  const scanPieces: string[] = [];

  if (depthLabel || qLabel) {
    const dq = [depthLabel, qLabel].filter(Boolean).join(' × ');
    scanPieces.push(`いまのあなたの場は、${dq || 'まだ形になりきっていないライン'} の上で動いています。`);
  }

  scanPieces.push(saLabel);

  if (phaseLabel) {
    scanPieces.push(phaseLabel);
  }

  if (yhLabel) {
    scanPieces.push(yhLabel);
  }

  scanPieces.push(modeLabel);

  lines.push(scanPieces.join('\n'));

  // ② いまの状態（IntentLine）
  if (intentNow || intentCore) {
    lines.push('');
    lines.push('🌱 いま開いている「状態」');
    if (intentNow) {
      lines.push(intentNow);
    }
    if (intentCore) {
      lines.push('');
      lines.push(`その奥で守ろうとしているものは、「${intentCore}」です。`);
    }
  }

  // ③ Irosとしての一手（ガイダンス）
  if (intentGuidance || intentRisk) {
    lines.push('');
    lines.push('🌀 Iros としていま提案したい一手');
    if (intentRisk) {
      lines.push(intentRisk);
    }
    if (intentGuidance) {
      lines.push(intentGuidance);
    }
  }

  // 何も情報がなければ空文字を返す
  const block = lines.join('\n').trim();
  return block.length > 0 ? block : '';
}
