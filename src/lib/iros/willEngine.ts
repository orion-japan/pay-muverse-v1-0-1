// src/lib/iros/willEngine.ts
// WILL エンジン：Depth drift（nextStep/ボタン意図）の解釈アダプタ
//
// 新憲法（前提）
// - 深度の「最終決定者」は三軸（deterministic）に寄せる。
// - WILL は「ボタン意図（nextStep）」を “補助入力” として解釈し、
//   unified の「候補 depth.stage」を更新するための純関数として提供する。
// - どこで最終採用するか（統合/優先順位）は上位（wire/orchestrator）で決める。
//   ここは「ボタン意図をどう読むか」だけを担う。

import type { UnifiedLikeAnalysis } from './unifiedAnalysis';
import type { QCode, FrameLayer } from './system';

/** ボタン側のギア（3段階） */
export type GearKind = 'safe-hold' | 'soft-rotate' | 'full-rotate';

/** nextStep.meta から渡ってくる情報 */
export type NextStepMeta = {
  /** 例: "S2" / "R1" / "I1"（null の場合は「任意」） */
  requestedDepth?: string | null;

  /** mirror / vision など（ここでは格納だけ） */
  requestedMode?: string | null;

  /** "stabilize" / "reframeIntention" などのゴール種別ヒント */
  goalKindHint?: string | null;
};

/** WILL に渡す入力（wire/orchestrator 側で組み立てる） */
export type DepthDriftInput = {
  currentDepth: string | null; // 例: "S2"
  qCode?: QCode | null; // Q1〜Q5（なくても動く）
  selfAcceptance?: number | null; // 0〜1（なくても動く）
  intentLayer?: FrameLayer | null; // 任意
  gear?: GearKind | null; // safe-hold / soft-rotate / full-rotate
  nextStepMeta?: NextStepMeta | null;
};

/** ドリフト安全度（Q / SA / intentLayer から推定） */
export type DriftSafety = 'conservative' | 'normal' | 'aggressive';

/** WILL の出力 */
export type DepthDriftOutput = {
  nextDepth: string | null;
  used: {
    gear: GearKind;
    requestedDepth?: string | null;
    goalKindHint?: string | null;
    appliedRequest: boolean;
    reason: string;
    safety: DriftSafety;
  };
};

/* =========================================================
 * 内部ユーティリティ（S/R/C/I のみ drift 対象）
 * ======================================================= */

type DriftBand = 'S' | 'R' | 'C' | 'I';

function isDriftBand(x: string): x is DriftBand {
  return x === 'S' || x === 'R' || x === 'C' || x === 'I';
}

/** "S2" → { band:"S", level:2 } （S/R/C/I 以外は null） */
function parseDepthStage(stage: string | null): { band: DriftBand; level: number } | null {
  const s = String(stage ?? '').trim();
  if (!s || s.length < 2) return null;

  const bandChar = s[0];
  const levelStr = s.slice(1);
  const level = Number.parseInt(levelStr, 10);
  if (!Number.isFinite(level)) return null;
  if (!isDriftBand(bandChar)) return null;

  return { band: bandChar, level };
}

/** band+level を "S2" 形式に組む（level は 1〜3 にクリップ） */
function buildDepthStage(band: DriftBand, level: number): string {
  let v = level;
  if (!Number.isFinite(v)) v = 1;
  if (v < 1) v = 1;
  if (v > 3) v = 3;
  return `${band}${v}`;
}

const BAND_ORDER: readonly DriftBand[] = ['S', 'R', 'C', 'I'] as const;

function bandIndex(b: DriftBand): number {
  const i = BAND_ORDER.indexOf(b);
  return i < 0 ? 0 : i;
}

/** target 方向に 1 ステップ寄せる（delta は -1 or +1） */
function shiftBandOneStep(cur: DriftBand, target: DriftBand): DriftBand {
  const ci = bandIndex(cur);
  const ti = bandIndex(target);
  if (ci === ti) return cur;
  return BAND_ORDER[ci + (ti > ci ? 1 : -1)] ?? cur;
}

/* =========================================================
 * 安全度（保守的に始める：boolean/離散で軽く検証）
 * ======================================================= */

function computeDriftSafety(params: {
  qCode?: QCode | null;
  selfAcceptance?: number | null;
  intentLayer?: FrameLayer | null;
}): DriftSafety {
  const { qCode, selfAcceptance, intentLayer } = params;

  // 1) 強い守り条件
  if (typeof selfAcceptance === 'number' && selfAcceptance < 0.4) return 'conservative';
  if (qCode === 'Q1' || qCode === 'Q3') return 'conservative';

  // 2) 攻めスコア（離散）
  let score = 0;
  if (typeof selfAcceptance === 'number' && selfAcceptance >= 0.7) score += 1;
  if (qCode === 'Q4' || qCode === 'Q5') score += 1;
  if (intentLayer === 'C' || intentLayer === 'I' || intentLayer === 'T') score += 1;

  if (score >= 2) return 'aggressive';
  return 'normal';
}

/* =========================================================
 * コア：nextStep.meta + gear + safety で drift を計算
 * ======================================================= */

export function computeDepthDriftWithNextStep(input: DepthDriftInput): DepthDriftOutput {
  const { currentDepth, qCode, selfAcceptance, intentLayer, gear, nextStepMeta } = input;

  // null/undefined を吸収して GearKind を確定
  const gearValue: GearKind = (gear ?? 'soft-rotate') as GearKind;

  const requestedDepth = nextStepMeta?.requestedDepth ?? null;
  const goalKindHint = nextStepMeta?.goalKindHint ?? null;

  const safety = computeDriftSafety({
    qCode: qCode ?? null,
    selfAcceptance: typeof selfAcceptance === 'number' ? selfAcceptance : null,
    intentLayer: intentLayer ?? null,
  });

  const cur = parseDepthStage(currentDepth);

  // current が解釈できない（例: T3 / F1 / null）→ drift 対象外なので維持
  if (!cur) {
    return {
      nextDepth: currentDepth,
      used: {
        gear: gearValue,
        requestedDepth,
        goalKindHint,
        appliedRequest: false,
        reason: 'currentDepth が S/R/C/I 形式でないため、WILL drift 対象外として維持',
        safety,
      },
    };
  }

  // requestedDepth がない or safe-hold → ボタン意図は採用しない
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
          : 'requestedDepth が未指定のため現状維持',
        safety,
      },
    };
  }

  const tgt = parseDepthStage(requestedDepth);
  if (!tgt) {
    return {
      nextDepth: currentDepth,
      used: {
        gear: gearValue,
        requestedDepth,
        goalKindHint,
        appliedRequest: false,
        reason: 'requestedDepth が S/R/C/I 形式でないため現状維持',
        safety,
      },
    };
  }

  // --- ここから drift ---
  let nextBand: DriftBand = cur.band;
  let nextLevel: number = cur.level;

  // full-rotate でも conservative のときは “soft 相当” に抑える（暴走防止）
  const effectiveGear: GearKind = gearValue === 'full-rotate' && safety === 'conservative'
    ? 'soft-rotate'
    : gearValue;

  if (effectiveGear === 'full-rotate') {
    // 基本：target に揃える
    nextBand = tgt.band;
    nextLevel = tgt.level;

    // stabilize はレベル変化を抑えめ（中間へ寄せる）
    if (goalKindHint === 'stabilize') {
      nextLevel = Math.round((cur.level + tgt.level) / 2);
    }

    // aggressive/normal はこのまま（離散で軽く検証）
  }

  if (effectiveGear === 'soft-rotate') {
    // 1) band を 1 ステップ寄せる（優先）
    if (cur.band !== tgt.band) {
      nextBand = shiftBandOneStep(cur.band, tgt.band);
    }

    // 2) level は conservative では動かさない（安定）
    if (safety !== 'conservative' && cur.level !== tgt.level) {
      const delta = tgt.level > cur.level ? 1 : -1;

      if (goalKindHint === 'stabilize') {
        // band が target に近づいたときだけ level を動かす（散乱抑制）
        if (nextBand === tgt.band) nextLevel = cur.level + delta;
      } else if (goalKindHint === 'reframeIntention') {
        // 視点切替を促す：level 優先で 1 ステップ
        nextLevel = cur.level + delta;
      } else {
        nextLevel = cur.level + delta;
      }
    }
  }

  const nextDepth = buildDepthStage(nextBand, nextLevel);

  // 同一なら「採用したけど結果は同じ」扱いにする（ログ/検証が安定）
  const applied = true;
  const changed = String(nextDepth) !== String(currentDepth ?? '');

  return {
    nextDepth: nextDepth,
    used: {
      gear: gearValue,
      requestedDepth,
      goalKindHint,
      appliedRequest: applied,
      reason: changed
        ? 'nextStep.meta + gear + safety により Depth を drift'
        : 'nextStep.meta を評価したが、同一Depthのため結果は維持',
      safety,
    },
  };
}

/* =========================================================
 * UnifiedLikeAnalysis へ適用（純関数）
 * ======================================================= */

export function applyWillDepthDrift(unified: UnifiedLikeAnalysis): UnifiedLikeAnalysis {
  const u: any = unified;

  const input: DepthDriftInput = {
    currentDepth: (u?.depth?.stage ?? null) as string | null,
    qCode: (u?.q?.current ?? null) as QCode | null,
    selfAcceptance: (u?.self_acceptance ?? null) as number | null,
    intentLayer: (u?.intentLayer ?? null) as FrameLayer | null,
    gear: (u?.nextStep?.gear ?? null) as GearKind | null,
    nextStepMeta: (u?.nextStep?.meta ?? null) as NextStepMeta | null,
  };

  const drift = computeDepthDriftWithNextStep(input);

  // ここは “候補 stage の更新” まで。最終採用は上位の統合ルールで決める。
  const nextStage = drift.nextDepth ?? (u?.depth?.stage ?? null);

  const next: any = {
    ...u,
    depth: {
      ...(u?.depth ?? {}),
      stage: nextStage,
    },
    // デバッグ用途：WILL が何を根拠にどう解釈したか（検証の一次材料）
    willDebug: {
      ...(u?.willDebug ?? {}),
      depthDrift: drift.used,
    },
  };

  return next as UnifiedLikeAnalysis;
}
