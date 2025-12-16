// src/lib/iros/orchestratorSpin.ts
// 3軸回転（spin）最小仕様（types.ts 正本参照版）
//
// - depthStage（点）と spin（運動）を混ぜない
// - 回転決定は Orchestrator のみ（Writer等は参照だけ）
// - 反転は強い兆候だけ
// - spinStep は慣性（前回値を基本）
//
// 仕様根拠：目的の定義PDF（spinLoop/spinStep, 反転条件, 慣性）
//

import type {
  Phase,
  QCode,
  DepthStage,
  SpinLoop,
  SpinStep,
  SpinState,
} from './types';
import { groupOfDepthStage, normalizeDepthStage } from './types';

export type ComputeSpinArgs = {
  // 現在ターンの確定済み状態（analysis/goal適用後の meta から渡す）
  depthStage: DepthStage | null | undefined;
  qCode: QCode | null | undefined;
  phase: Phase | null | undefined;

  // 前回までの保存状態（MemoryState/baseMeta 等から）
  lastSpinLoop?: SpinLoop | null;
  lastSpinStep?: SpinStep | null;
  lastPhase?: Phase | null;
};

function initialLoopFromDepth(depthStage?: DepthStage | null): SpinLoop {
  // 初期値（未設定のとき）
  // S/R/I 群 → SRI
  // T/C/F 群 → TCF
  const g = groupOfDepthStage(depthStage);
  if (g === 'S' || g === 'R' || g === 'I') return 'SRI';
  return 'TCF';
}

function shouldFlip_SRI_to_TCF(params: {
  lastPhase?: Phase | null;
  phase?: Phase | null;
  depthStage?: DepthStage | null;
}): boolean {
  // SRI → TCF 反転条件（最小）
  // phase: Inner → Outer かつ depthStage: I2/I3/T1 付近
  const { lastPhase, phase, depthStage } = params;
  const phaseFlip = lastPhase === 'Inner' && phase === 'Outer';
  if (!phaseFlip) return false;

  return depthStage === 'I2' || depthStage === 'I3' || depthStage === 'T1';
}

function shouldFlip_TCF_to_SRI(params: {
  qCode?: QCode | null;
  lastPhase?: Phase | null;
  phase?: Phase | null;
}): boolean {
  // TCF → SRI 反転条件（最小）
  // qCode: Q3/Q4/Q5 かつ phase: Outer → Inner
  const { qCode, lastPhase, phase } = params;
  const phaseFlip = lastPhase === 'Outer' && phase === 'Inner';
  if (!phaseFlip) return false;

  return qCode === 'Q3' || qCode === 'Q4' || qCode === 'Q5';
}

function stepFromDepth(loop: SpinLoop, depthStage?: DepthStage | null): SpinStep | null {
  const g = groupOfDepthStage(depthStage);

  if (loop === 'SRI') {
    if (g === 'S') return 0;
    if (g === 'R') return 1;
    if (g === 'I') return 2;
    return null;
  }

  // TCF
  if (g === 'T') return 0;
  if (g === 'C') return 1;
  if (g === 'F') return 2;
  return null;
}

/**
 * computeSpinState
 * - spinLoop/spinStep を決める（最小・堅い）
 * - step は慣性：原則 lastSpinStep を維持し、depth が一致したときだけ更新
 *
 * NOTE:
 * - depthStage は normalizeDepthStage を通し、"S4" など幽霊値は null 扱いにする
 */
export function computeSpinState(args: ComputeSpinArgs): SpinState {
  const {
    depthStage,
    qCode,
    phase,
    lastSpinLoop,
    lastSpinStep,
    lastPhase,
  } = args;

  const depth = normalizeDepthStage(depthStage);

  // 1) ループの初期決定（未設定なら depth 群から）
  let loop: SpinLoop = (lastSpinLoop ?? null) || initialLoopFromDepth(depth);

  // 2) 反転条件（強い兆候だけ）
  if (loop === 'SRI') {
    if (shouldFlip_SRI_to_TCF({ lastPhase, phase, depthStage: depth })) {
      loop = 'TCF';
    }
  } else {
    if (shouldFlip_TCF_to_SRI({ qCode, lastPhase, phase })) {
      loop = 'SRI';
    }
  }

  // 3) step 決定（depth の頭文字で決める。ただし飛びを防ぐため“維持”が基本）
  const mapped = stepFromDepth(loop, depth);

  // 慣性：mapped が取れたときだけ更新。取れないときは last を維持。
  const step: SpinStep = (mapped ?? (lastSpinStep ?? null) ?? 0) as SpinStep;

  return { spinLoop: loop, spinStep: step };
}
