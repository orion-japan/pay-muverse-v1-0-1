// src/lib/iros/willEngine.ts
// WILL エンジン：Depth drift 用コア & nextStep.meta 解釈アダプタ

import type { UnifiedLikeAnalysis } from './unifiedAnalysis';

// Qコード種別（必要なら既存の型に合わせて調整してください）
export type QCode = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';

// ボタン側のギア（レポートで出てきた3段階）
export type GearKind = 'safe-hold' | 'soft-rotate' | 'full-rotate';

// nextStep.meta から渡ってくる情報
export type NextStepMeta = {
  // 例: "S2" / "R1" / "I1" など（null の場合は「任意」）
  requestedDepth?: string | null;
  // mirror / vision など、モードのヒント（ここでは格納だけしておく）
  requestedMode?: string | null;
  // "stabilize" / "reframeIntention" などのゴール種別
  goalKindHint?: string | null;
};

// WILL に渡す入力（必要に応じて既存構造にマージしてください）
export type DepthDriftInput = {
  currentDepth: string | null;       // 例: "S2"
  qCode?: QCode | null;              // Q1〜Q5（なくても動く）
  selfAcceptance?: number | null;    // 0.1〜1.0（なくても動く）
  intentLayer?: 'S' | 'R' | 'C' | 'I' | 'T' | null; // I層帯域（任意）
  gear?: GearKind | null;            // safe-hold / soft-rotate / full-rotate
  nextStepMeta?: NextStepMeta | null;
};

// WILL の出力（最終的に unified.depth.stage などに入る値）
export type DepthDriftOutput = {
  nextDepth: string | null;
  // どんな意図を使ったかをメモしておくとデバッグしやすい
  used: {
    gear: GearKind;                 // ← GearKind に統一（内部でnullは吸収）
    requestedDepth?: string | null;
    goalKindHint?: string | null;
    // 実際に「ボタン意図を採用したかどうか」
    appliedRequest: boolean;
    reason: string;
    // ★ 追加：Q / SA / intentLayer から計算した安全度
    safety: DriftSafety;
  };
};

/**
 * "S2" → { band: "S", level: 2 } に分解
 */
function parseDepthStage(stage: string | null): { band: 'S' | 'R' | 'C' | 'I'; level: number } | null {
  if (!stage || stage.length < 2) return null;

  const bandChar = stage[0];
  const levelStr = stage.slice(1);
  const level = parseInt(levelStr, 10);

  if (!Number.isFinite(level)) return null;

  if (bandChar === 'S' || bandChar === 'R' || bandChar === 'C' || bandChar === 'I') {
    return { band: bandChar as 'S' | 'R' | 'C' | 'I', level };
  }

  // T層などは、ここでは drift 対象外として扱う
  return null;
}

/**
 * band + level を "S2" 形式に組み立て直す
 */
function buildDepthStage(band: 'S' | 'R' | 'C' | 'I', level: number): string {
  // レベルの下限・上限は仮に 1〜3 にクリップ
  let safeLevel = level;
  if (safeLevel < 1) safeLevel = 1;
  if (safeLevel > 3) safeLevel = 3;
  return `${band}${safeLevel}`;
}

/**
 * band の順序を S → R → C → I として、+1 / -1 方向に進める
 */
function shiftBand(band: 'S' | 'R' | 'C' | 'I', delta: number): 'S' | 'R' | 'C' | 'I' {
  const order: Array<'S' | 'R' | 'C' | 'I'> = ['S', 'R', 'C', 'I'];
  const idx = order.indexOf(band);
  if (idx === -1) return band;

  let nextIdx = idx + delta;
  if (nextIdx < 0) nextIdx = 0;
  if (nextIdx > order.length - 1) nextIdx = order.length - 1;

  return order[nextIdx];
}

/* ========= 追加：ドリフト安全度（Q / SA / intentLayer から推定） ========= */

export type DriftSafety = 'conservative' | 'normal' | 'aggressive';

function computeDriftSafety(params: {
  qCode?: QCode | null;
  selfAcceptance?: number | null;
  intentLayer?: 'S' | 'R' | 'C' | 'I' | 'T' | null;
}): DriftSafety {
  const { qCode, selfAcceptance, intentLayer } = params;

  // 1. 強めの「守り」条件 → 即 conservative
  if (typeof selfAcceptance === 'number' && selfAcceptance < 0.4) {
    return 'conservative';
  }
  if (qCode === 'Q1' || qCode === 'Q3') {
    return 'conservative';
  }

  // 2. 攻めたい条件をスコア加算
  let aggressiveScore = 0;

  if (typeof selfAcceptance === 'number' && selfAcceptance >= 0.7) {
    aggressiveScore += 1;
  }
  if (qCode === 'Q4' || qCode === 'Q5') {
    aggressiveScore += 1;
  }
  if (intentLayer === 'C' || intentLayer === 'I' || intentLayer === 'T') {
    aggressiveScore += 1;
  }

  if (aggressiveScore >= 2) {
    return 'aggressive';
  }

  // 3. どちらでもない → normal
  return 'normal';
}

/**
 * requestedDepth へ「どのくらい寄せるか」を計算する。
 *
 * - safe-hold: ほぼ現在位置のまま（ボタン意図は採用しない）
 * - soft-rotate: 1ステップ分だけ target に近づく（小回転）
 * - full-rotate: band も level も一気に target に揃える（大回転）
 *
 * goalKindHint:
 * - "stabilize": レベル変化を小さめに（band優先）
 * - "reframeIntention": band変化を優先して I / C 側へ寄りやすく
 *
 * DriftSafety:
 * - conservative: 「守り」寄り → band だけ or 小さな変化に抑える
 * - normal: 既存ロジック通り
 * - aggressive: full-rotate 時にそのまま target に合わせやすく
 */
export function computeDepthDriftWithNextStep(input: DepthDriftInput): DepthDriftOutput {
  const {
    currentDepth,
    qCode,
    selfAcceptance,
    intentLayer,
    gear,
    nextStepMeta,
  } = input;

  // null/undefined をここで吸収して、以降は GearKind 確定
  const gearValue: GearKind = gear ?? 'soft-rotate';

  const parsedCurrent = parseDepthStage(currentDepth);
  const requestedDepth = nextStepMeta?.requestedDepth ?? null;
  const goalKindHint = nextStepMeta?.goalKindHint ?? null;

  const safety = computeDriftSafety({ qCode: qCode ?? null, selfAcceptance, intentLayer });

  // 基本方針: currentDepth が解釈できない / requestedDepth がない / safe-hold の場合はそのまま返す
  if (!parsedCurrent) {
    return {
      nextDepth: currentDepth,
      used: {
        gear: gearValue,
        requestedDepth,
        goalKindHint,
        appliedRequest: false,
        reason: 'currentDepth が未定義 or 解釈不能のため、そのまま維持',
        safety,
      },
    };
  }

  if (!requestedDepth || gearValue === 'safe-hold') {
    return {
      nextDepth: currentDepth,
      used: {
        gear: gearValue,
        requestedDepth,
        goalKindHint,
        appliedRequest: false,
        reason: gearValue === 'safe-hold'
          ? 'safe-hold ギアのため、ボタン意図を採用せず現状維持'
          : 'requestedDepth が指定されていないため、現状維持',
        safety,
      },
    };
  }

  const parsedTarget = parseDepthStage(requestedDepth);
  if (!parsedTarget) {
    return {
      nextDepth: currentDepth,
      used: {
        gear: gearValue,
        requestedDepth,
        goalKindHint,
        appliedRequest: false,
        reason: 'requestedDepth が "S2" 形式でないため、現状維持',
        safety,
      },
    };
  }

  // ここから、ギアと goalKind / safety を見ながら「どこまで寄せるか」を決める
  const { band: curBand, level: curLevel } = parsedCurrent;
  const { band: tgtBand, level: tgtLevel } = parsedTarget;

  let nextBand = curBand;
  let nextLevel = curLevel;

  if (gearValue === 'full-rotate') {
    if (safety === 'conservative') {
      // フル回転要求でも「守り」モードのときは、
      // 一気には飛ばさず soft-rotate 相当の動きに抑える
      nextBand = curBand !== tgtBand
        ? shiftBand(curBand, curBand < tgtBand ? 1 : -1)
        : curBand;

      // level は据え置き or ごく小さな変化
      if (curLevel !== tgtLevel && goalKindHint !== 'stabilize') {
        const levelDelta = tgtLevel > curLevel ? 1 : -1;
        nextLevel = curLevel + levelDelta;
      }
    } else {
      // フル回転：target にほぼ合わせる
      nextBand = tgtBand;
      nextLevel = tgtLevel;

      // ただし「stabilize」の場合はレベルだけ少し抑える
      if (goalKindHint === 'stabilize') {
        // 中間レベルに寄せる（例: 3 → 2）
        const midLevel = Math.round((curLevel + tgtLevel) / 2);
        nextLevel = midLevel;
      }

      // aggressive のときはそのまま、normal もこのまま扱う
    }
  } else if (gearValue === 'soft-rotate') {
    // 小回転：一歩だけ target へ近づく

    // 1) band を 1ステップだけ寄せるか
    if (curBand !== tgtBand) {
      nextBand = shiftBand(curBand, curBand < tgtBand ? 1 : -1);
    }

    // 2) level を 1ステップだけ寄せるか
    // conservative の場合は「band だけ寄せて level は据え置き」にして、
    // なるべく安定側に保つ
    if (safety !== 'conservative' && curLevel !== tgtLevel) {
      // "stabilize" の場合は、レベル変化をより小さくする（band変化を優先）
      const levelDelta = tgtLevel > curLevel ? 1 : -1;
      if (goalKindHint === 'stabilize') {
        // band がすでに target に近づいた場合のみ level を変える
        if (nextBand === tgtBand) {
          nextLevel = curLevel + levelDelta;
        }
      } else if (goalKindHint === 'reframeIntention') {
        // reframeIntention はレベル変化を優先して「視点切替」を促す
        nextLevel = curLevel + levelDelta;
      } else {
        // 通常
        nextLevel = curLevel + levelDelta;
      }
    }
  }

  const nextDepth = buildDepthStage(nextBand, nextLevel);

  return {
    nextDepth,
    used: {
      gear: gearValue,
      requestedDepth,
      goalKindHint,
      appliedRequest: true,
      reason: 'nextStep.meta とギア設定 + safety に基づき、Depth を drift させた',
      safety,
    },
  };
}

/**
 * UnifiedLikeAnalysis に対して「Depth drift（ボタン反映）」を適用する
 * 実際に呼び出すときは、wire.orchestrator.ts などから：
 *
 *   unified = applyWillDepthDrift(unified);
 *
 * のように 1 行挟むイメージです。
 */
export function applyWillDepthDrift(unified: UnifiedLikeAnalysis): UnifiedLikeAnalysis {
  const u: any = unified;

  const input: DepthDriftInput = {
    currentDepth: u.depth?.stage ?? null,
    qCode: u.q?.current ?? null,
    selfAcceptance: u.self_acceptance ?? null,
    intentLayer: u.intentLayer ?? null,
    gear: u.nextStep?.gear ?? null,
    nextStepMeta: u.nextStep?.meta ?? null,
  };

  const drift = computeDepthDriftWithNextStep(input);

  const next: any = {
    ...u,
    depth: {
      ...(u.depth ?? {}),
      stage: drift.nextDepth,
    },
    // デバッグ用に drift 情報を残しておく
    willDebug: {
      ...(u.willDebug ?? {}),
      depthDrift: drift.used,
    },
  };

  return next as UnifiedLikeAnalysis;
}
