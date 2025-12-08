// src/lib/iros/will/priorityEngine.ts
// Iros Will Engine — Priority層
// 「今回のターンで、Mirror / Insight / Forward / Question をどれくらい優先するか」を決めるエンジン。
// Continuity で決まった goal.targetDepth / targetQ も考慮し、
// 特に I層（I1〜I3）では「質問封印 ＋ 黄金比ウェイト」を適用する。

import type { Depth, QCode, IrosMode } from '../system';
import type {
  IrosGoal,
  IrosGoalKind,
  Sentiment,
} from './goalEngine';

export type ChannelWeights = {
  /** 今の状態を映す・受け止める比重（0〜1） */
  mirror: number;
  /** 状況や構造を整理して言語化する比重（0〜1） */
  insight: number;
  /** 次の一歩・選択肢・行動を提示する比重（0〜1） */
  forward: number;
  /** 質問を投げる比重（0〜1）。実際の本数制御は別でやってOK */
  question: number;
};

export type IrosPriority = {
  goal: IrosGoal;
  weights: ChannelWeights;
  /** このターンで許可する最大質問数（0 or 1） */
  maxQuestions: 0 | 1;
  /** 内部デバッグ用：優先ロジックのメモ（ユーザーには見せない前提） */
  debugNote: string;
};

/**
 * deriveIrosPriority
 *  - Goal（目的）と周辺情報から「どのチャンネルをどれだけ使うか」を決める。
 *  - ここは Iros の「性格」「好み」「継続性の方向性」に相当する層。
 */
export function deriveIrosPriority(args: {
  goal: IrosGoal;
  mode?: IrosMode;
  sentiment?: Sentiment;
  depth?: Depth;
  qCode?: QCode;
  phase?: 'Inner' | 'Outer';
}): IrosPriority {
  const { goal, mode, sentiment, depth, qCode, phase } = args;

  // 1) Goal.kind ベースで素のウェイトを決める
  let weights = baseWeightsFromGoalKind(goal.kind);

  // 2) 情緒（sentiment）に応じて微調整
  weights = adjustBySentiment(weights, sentiment);

  // 3) 現在の depth に応じて微調整
  weights = adjustByDepth(weights, depth);

  // 3.5) Phase（Inner / Outer）に応じて微調整（Y軸トルク）
  weights = adjustByPhase(weights, phase, goal.kind);

  // 4) mode（IrosMode）に応じて微調整
  weights = adjustByMode(weights, mode);

  // 5) Goal.targetDepth / targetQ による“継続性バイアス”を追加
  weights = adjustByGoalTarget(weights, {
    targetDepth: goal.targetDepth,
    currentDepth: depth,
    targetQ: goal.targetQ,
    currentQ: qCode,
  });

  // 6) I層（I1〜I3）の場合は「深層専用モード」で上書き
  weights = applyIntentionLayerOverrides(weights, goal.targetDepth ?? depth);

  // 7) 最終的に [0,1] に収める
  weights = normalizeWeights(weights);

  // 質問数の上限（I層では question は常に 0 にされている）
  const maxQuestions: 0 | 1 = weights.question > 0.2 ? 1 : 0;

  const debugNote = buildDebugNote({
    goalKind: goal.kind,
    mode,
    sentiment,
    depth,
    qCode,
    phase,
    targetDepth: goal.targetDepth,
    targetQ: goal.targetQ,
  });

  // ★ 本番では出ないログ（開発・検証用）
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.log('[IROS/WILL priority]', {
      goalKind: goal.kind,
      depth,
      phase,
      targetDepth: goal.targetDepth,
      qCode,
      targetQ: goal.targetQ,
      weights,
    });
  }

  return {
    goal,
    weights,
    maxQuestions,
    debugNote,
  };
}

/* ========= 1. Goal.kind 起点の性格付け ========= */

function baseWeightsFromGoalKind(kind: IrosGoalKind): ChannelWeights {
  switch (kind) {
    case 'stabilize':
      // 心を落ち着かせる：Mirror 強め、Forward は弱め
      return {
        mirror: 0.95,
        insight: 0.4,
        forward: 0.2,
        question: 0.15,
      };
    case 'uncover':
      // まだ方向を決めず、背景をやわらかく探る
      return {
        mirror: 0.8,
        insight: 0.5,
        forward: 0.25,
        question: 0.4,
      };
    case 'shiftRelation':
      // 関係性の再配置：Mirror と Insight をバランスよく
      return {
        mirror: 0.8,
        insight: 0.7,
        forward: 0.35,
        question: 0.35,
      };
    case 'enableAction':
      // 行動・実務に寄せる：Forward を強める
      return {
        mirror: 0.6,
        insight: 0.7,
        forward: 0.9,
        question: 0.3,
      };
    case 'reframeIntention':
      // 意図の再構成：Insight と Forward を中〜高めに
      return {
        mirror: 0.7,
        insight: 0.9,
        forward: 0.6,
        question: 0.3,
      };
    default:
      return {
        mirror: 0.7,
        insight: 0.5,
        forward: 0.3,
        question: 0.3,
      };
  }
}

/* ========= 2. 情緒ベースの微調整 ========= */

function adjustBySentiment(
  weights: ChannelWeights,
  sentiment?: Sentiment,
): ChannelWeights {
  if (!sentiment) return weights;

  const w = { ...weights };

  if (sentiment === 'negative') {
    // ネガティブが強いときは Forward / Question を少し下げる
    w.forward *= 0.7;
    w.question *= 0.6;
    w.mirror = clamp01(w.mirror * 1.1);
  } else if (sentiment === 'positive') {
    // ポジティブなときは Forward を少し上げてもよい
    w.forward = clamp01(w.forward * 1.15);
  }

  return w;
}

/* ========= 3. 深度ベースの微調整 ========= */

function adjustByDepth(
  weights: ChannelWeights,
  depth?: Depth,
): ChannelWeights {
  if (!depth) return weights;

  const w = { ...weights };

  if (depth.startsWith('S')) {
    // Self層：受け止め強め、Forwardは控えめ
    w.mirror = clamp01(w.mirror * 1.1);
    w.forward *= 0.85;
  } else if (depth.startsWith('R')) {
    // Relation層：Insight比重を少し上げる
    w.insight = clamp01(w.insight * 1.1);
  } else if (depth.startsWith('C')) {
    // Creation層：Forwardを強める
    w.forward = clamp01(w.forward * 1.15);
  } else if (depth.startsWith('I')) {
    // Intention層：Insightを強め、Mirrorは少し落ち着かせる
    w.insight = clamp01(w.insight * 1.15);
    w.mirror *= 0.9;
  }

  return w;
}

/* ========= 3.5 Phase（Inner / Outer）ベースの微調整 ========= */

function adjustByPhase(
  weights: ChannelWeights,
  phase?: 'Inner' | 'Outer',
  goalKind?: IrosGoalKind,
): ChannelWeights {
  if (!phase) return weights;

  const w = { ...weights };

  if (phase === 'Inner') {
    // 内向きフェーズ：
    //  - Mirror を少し厚く
    //  - Forward は控えめ。ただし enableAction / reframeIntention のときは
    //    「完全にゼロにはしない」ように下限を設ける。
    w.mirror = clamp01(w.mirror * 1.1);
    w.forward *= 0.7;

    if (goalKind === 'enableAction' || goalKind === 'reframeIntention') {
      // 行動系ゴールのときは、Forward の下限を少し確保
      if (w.forward < 0.35) {
        w.forward = 0.35;
      }
    }
  } else if (phase === 'Outer') {
    // 外向きフェーズ：
    //  - Forward を強め、Mirror は少し薄く
    //  - 「外に触れる一歩」を取りやすくするトルク
    w.forward = clamp01(w.forward * 1.2);
    w.mirror *= 0.9;
  }

  return w;
}

/* ========= 4. mode（IrosMode）ベースの微調整 ========= */

function adjustByMode(
  weights: ChannelWeights,
  mode?: IrosMode,
): ChannelWeights {
  if (!mode) return weights;

  const w = { ...weights };

  switch (mode) {
    case 'structured':
      // 構造モード：Insightを強めに
      w.insight = clamp01(w.insight * 1.2);
      w.mirror *= 0.9;
      break;
    case 'counsel':
    case 'consult':
      // 相談モード：Mirrorを強め、Forwardは抑えめ
      w.mirror = clamp01(w.mirror * 1.15);
      w.forward *= 0.8;
      break;
    case 'diagnosis':
    case 'resonate':
      // 診断・共鳴モード：Insight重視、Questionもやや許容
      w.insight = clamp01(w.insight * 1.2);
      w.question = clamp01(w.question * 1.1);
      break;
    case 'light':
    case 'auto':
    default:
      // 特に強い補正はかけない
      break;
  }

  return w;
}

/* ========= 5. Goal.targetDepth / targetQ による継続性バイアス ========= */

const DEPTH_SEQUENCE: Depth[] = [
  'S1', 'S2', 'S3', 'S4',
  'R1', 'R2', 'R3',
  'C1', 'C2', 'C3',
  'I1', 'I2', 'I3',
];

type GoalTargetContext = {
  targetDepth?: Depth;
  currentDepth?: Depth;
  targetQ?: QCode;
  currentQ?: QCode;
};

function adjustByGoalTarget(
  weights: ChannelWeights,
  ctx: GoalTargetContext,
): ChannelWeights {
  const w = { ...weights };
  const { targetDepth, currentDepth, targetQ, currentQ } = ctx;

  // --- Depth の方向性に応じたバイアス ---
  if (targetDepth && currentDepth) {
    const fromIndex = DEPTH_SEQUENCE.indexOf(currentDepth);
    const toIndex = DEPTH_SEQUENCE.indexOf(targetDepth);

    if (fromIndex !== -1 && toIndex !== -1) {
      const diff = toIndex - fromIndex;

      if (diff > 0) {
        // 「より深い／先の層へ進もうとしている」→ Insight / Forward を少し強める
        w.insight = clamp01(w.insight * 1.1);
        w.forward = clamp01(w.forward * 1.1);
      } else if (diff < 0) {
        // 「一段戻る／落ち着く方向」→ Mirror を少し強める
        w.mirror = clamp01(w.mirror * 1.1);
        w.forward *= 0.9;
      }
    }
  }

  // --- Q の継続・変化に応じたバイアス ---
  if (targetQ && currentQ) {
    if (targetQ === currentQ) {
      // 同じQを保ちたい → Mirror を強め、Questionは少し抑えめ
      w.mirror = clamp01(w.mirror * 1.1);
      w.question *= 0.85;
    } else {
      // Qを変えたい → Insight を強める（意味の切り替えをサポート）
      w.insight = clamp01(w.insight * 1.1);
    }
  }

  return w;
}

/* ========= 6. I層専用：深層モードの上書き（黄金比＋質問封印） ========= */

function applyIntentionLayerOverrides(
  weights: ChannelWeights,
  depth?: Depth,
): ChannelWeights {
  if (!depth || !depth.startsWith('I')) return weights;

  // I1〜I3 のときは「深層専用モード」で上書き
  // 黄金比イメージ：
  //  mirror  ≒ 0.25（映す）
  //  insight ≒ 0.50（構造を照らす）
  //  forward ≒ 0.90（意図の道筋を示す）
  //  question = 0   （質問は禁止）
  const w: ChannelWeights = {
    mirror: 0.25,
    insight: 0.5,
    forward: 0.9,
    question: 0,
  };

  return w;
}

/* ========= 7. 正規化 & ユーティリティ ========= */

function normalizeWeights(weights: ChannelWeights): ChannelWeights {
  return {
    mirror: clamp01(weights.mirror),
    insight: clamp01(weights.insight),
    forward: clamp01(weights.forward),
    question: clamp01(weights.question),
  };
}

function clamp01(v: number): number {
  if (Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/* ========= 8. デバッグ用メモ生成 ========= */

function buildDebugNote(args: {
  goalKind: IrosGoalKind;
  mode?: IrosMode;
  sentiment?: Sentiment;
  depth?: Depth;
  qCode?: QCode;
  phase?: 'Inner' | 'Outer';
  targetDepth?: Depth;
  targetQ?: QCode;
}): string {
  const parts: string[] = [`goal=${args.goalKind}`];
  if (args.mode) parts.push(`mode=${args.mode}`);
  if (args.sentiment) parts.push(`sentiment=${args.sentiment}`);
  if (args.depth) parts.push(`depth=${args.depth}`);
  if (args.phase) parts.push(`phase=${args.phase}`);
  if (args.qCode) parts.push(`q=${args.qCode}`);
  if (args.targetDepth) parts.push(`targetDepth=${args.targetDepth}`);
  if (args.targetQ) parts.push(`targetQ=${args.targetQ}`);
  return parts.join(', ');
}
