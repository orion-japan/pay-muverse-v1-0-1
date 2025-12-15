// src/lib/iros/soul/shouldUseSoul.ts
// Iros Soul を起動するかどうかの判定（failsafe 専用）
//
// 方針（2025-12-14 合意）
// - Soul はミラー/語り手ではなく、failsafe 専用モジュール
// - 通常ルートでは絶対に呼ばない
// - 3軸（Q / Depth / Phase）が欠損・不整合・破損している場合のみ true

import type { IrosSoulInput } from './types';

/** Qコードの妥当値（failsafe 判定用） */
const VALID_Q = new Set(['Q1', 'Q2', 'Q3', 'Q4', 'Q5']);

/** Phase の妥当値（failsafe 判定用） */
const VALID_PHASE = new Set(['Inner', 'Outer']);

/** DepthStage の妥当値（S1〜I3, T1〜T3 を許容） */
function isValidDepthStage(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  // 例: S1..S6 / R1..R3 / C1..C3 / I1..I3 / T1..T3 など
  // ※あなたの実装に合わせて必要ならレンジを絞ってOK
  return /^(S|F|R|C|I|T)[0-9]+$/.test(v);
}

/**
 * Soul を回すかどうか（failsafe only）
 * true になるのは「3軸が壊れている/取れていない/不整合」のときだけ。
 */
export function shouldUseSoul(input: IrosSoulInput): boolean {
  const { qCode, depthStage, phase } = input;

  // ---- 1) 3軸の欠損（最優先） ------------------------------------
  // qCode は null になり得る型なので「null の時点で failsafe」
  if (qCode == null) return true;

  // depthStage / phase も未取得なら failsafe
  if (depthStage == null) return true;
  if (phase == null) return true;

  // ---- 2) 3軸の不整合（壊れた値が混入） ----------------------------
  if (!VALID_Q.has(String(qCode))) return true;
  if (!isValidDepthStage(depthStage)) return true;
  if (!VALID_PHASE.has(String(phase))) return true;

  // ---- 3) ここまで来たら正常：Soul は呼ばない ----------------------
  return false;
}
