// src/lib/iros/will/rotationEngine.ts
// 三軸回転エンジン
// S/F → R/C → I/T を「1ターンにつき 1ステップだけ」回転させる

import type { Depth, QCode } from '../system';
import type { IrosGoalKind } from './goalEngine';

/**
 * 回転判定に使うコンテキスト
 */
export type RotationContext = {
  /** 直前ターンの Depth */
  lastDepth?: Depth | null;

  /** 今回の基準となる Depth（goal.targetDepth / depth / lastDepth から決定） */
  currentDepth?: Depth | null;

  /** 今回の qCode */
  qCode?: QCode | null;

  /** 直前ターンの Goal.kind */
  lastGoalKind?: IrosGoalKind | null;

  /** uncover 系が何ターン連続しているか（orchestrator 側で計算） */
  uncoverStreak?: number;

  /** SelfAcceptance ライン（0〜1） */
  selfAcceptance?: number | null;

  /** SoulLayer の risk_flags（危険フラグ） */
  riskFlags?: string[] | null;

  /** 「ステイしてほしい」明示がある場合 true */
  stayRequested: boolean;
};

/**
 * 回転判定の結果
 */
export type RotationDecision = {
  /** 今ターン、帯域を回転させるかどうか */
  shouldRotate: boolean;

  /** 回転後の Depth（回転しない場合は undefined のままでもOK） */
  nextDepth?: Depth;

  /** デバッグ用の理由テキスト（ユーザーにはそのまま出ささない） */
  reason: string;
};

/**
 * 実際に回転させるかどうかを決める純関数
 */
export function shouldRotateBand(
  ctx: RotationContext,
): RotationDecision {
  const {
    lastDepth,
    currentDepth,
    qCode,
    lastGoalKind,
    uncoverStreak,
    selfAcceptance,
    riskFlags,
    stayRequested,
  } = ctx;

  const baseDepth: Depth | null =
    (currentDepth as Depth | null) ??
    (lastDepth as Depth | null) ??
    null;

  // Depth がない場合はそもそも回転対象にできない
  if (!baseDepth) {
    return {
      shouldRotate: false,
      nextDepth: undefined,
      reason: 'baseDepth が未定義のため回転しない',
    };
  }

  // ① ユーザーから「ステイ」が明示されている場合は回転しない
  if (stayRequested) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      reason: 'ユーザーのステイ意図があるため回転しない',
    };
  }

  // ② SelfAcceptance が低すぎる場合は安全優先で固定
  if (typeof selfAcceptance === 'number' && selfAcceptance < 0.3) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      reason:
        'SelfAcceptance < 0.3 のため安全側を優先して回転しない',
    };
  }

  // ③ 危険フラグ（うつ・自傷など）がある場合は回転しない
  const risk = riskFlags ?? [];
  const hasSevereRisk = risk.some((r) =>
    ['q5_depress', 'suicide_risk', 'self_harm', 'panic'].includes(r),
  );
  if (hasSevereRisk) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      reason:
        'SoulLayer の risk_flags に重いリスクがあるため回転しない',
    };
  }

  // ④ 三軸回転のトリガー条件
  // - 基本は「S帯で Q3 が続き、uncover 系が連続している」とき
  const depthHead = baseDepth[0]; // 'S' | 'R' | 'C' | 'I' | 'T'
  const streak = uncoverStreak ?? 0;

  const isSBand = depthHead === 'S';
  const isQ3 = qCode === 'Q3';
  const isUncoverLike =
    lastGoalKind === 'uncover' || lastGoalKind === 'stabilize';

  const triggerSBand =
    isSBand && isQ3 && isUncoverLike && streak >= 2;

  if (!triggerSBand) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      reason:
        'S帯でQ3かつuncover連続(>=2)の条件を満たしていないため回転しない',
    };
  }

  // ⑤ 実際に 1 ステップだけ帯域を上げる
  const next = nextDepthForBand(baseDepth);

  // これ以上回せない場合はそのまま
  if (!next || next === baseDepth) {
    return {
      shouldRotate: false,
      nextDepth: baseDepth,
      reason: 'これ以上上位帯域がないため回転しない',
    };
  }

  return {
    shouldRotate: true,
    nextDepth: next,
    reason:
      'S帯でQ3かつuncover連続(>=2)かつ安全条件クリアのため、上位帯域へ1ステップ回転',
  };
}

/**
 * 「帯域」単位で一段だけ上に回転させた Depth を返す
 *
 * S/F → R/C → I/T
 * - S帯(S1〜S3) → R帯の入口 = R1
 * - R/C帯(R1〜C3) → I帯の入口 = I1
 * - I/T帯(I1〜T3) → それ以上は回転させない（T側で頭打ち）
 */
export function nextDepthForBand(current: Depth): Depth {
  const head = current[0]; // 'S' | 'R' | 'C' | 'I' | 'T'

  // S/F 帯 → R/C 帯の入口 R1
  if (head === 'S') {
    return 'R1';
  }

  // R/C 帯 → I/T 帯の入口 I1
  if (head === 'R' || head === 'C') {
    return 'I1';
  }

  // I/T 帯はこれ以上「上」の帯域がないので現状維持
  if (head === 'I' || head === 'T') {
    return current;
  }

  // 想定外はそのまま返す（保険）
  return current;
}
