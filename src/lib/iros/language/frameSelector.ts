// src/lib/iros/language/frameSelector.ts
// iros — Layer C: Frame Selector（器の選択）
// - 入力: meta(depth/descentGate) + inputKind だけ
// - 出力: FRAME（器）
// - LLMは使わない（純関数）

import type { Depth } from '@/lib/iros/system';
import type { DescentGateState } from '@/lib/iros/rotation/rotationLoop';

export type FrameKind =
  | 'S'
  | 'R'
  | 'C'
  | 'I'
  | 'T'
  | 'F'
  | 'MICRO'
  | 'NONE';

export type InputKind =
  | 'micro' // 短文・一言・相槌
  | 'greeting'
  | 'chat'
  | 'question'
  | 'request' // 実務依頼（実装/手順/調査など）
  | 'debug' // ログ/エラー/原因追跡
  | 'unknown';

export type FrameSelectorMeta = {
  depth?: Depth | null;

  /**
   * ✅ 方針：descentGate は boolean を捨てて string union に統一
   * - 'closed'   : 通常
   * - 'offered'  : 下降提案
   * - 'accepted' : 下降中（保持）
   *
   * 互換：古い boolean が来てもここで吸収
   */
  descentGate?: DescentGateState | boolean | null;
};

function depthBand(depth?: Depth | null): 'S' | 'F' | 'R' | 'C' | 'I' | 'T' | null {
  if (!depth) return null;
  const c = String(depth)[0]?.toUpperCase() as any;
  if (c === 'S' || c === 'F' || c === 'R' || c === 'C' || c === 'I' || c === 'T') return c;
  return null;
}

function isDescentOn(v: FrameSelectorMeta['descentGate']): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  // DescentGateState
  return v !== 'closed';
}

/**
 * Frame 選択（最小確定版）
 * 優先順位：
 * 1) descentGate ON → MICRO（短文でも崩れない器）を基本に、必要なら S
 * 2) inputKind micro/greeting → MICRO/NONE
 * 3) request/debug → C（作業・手順の器）
 * 4) depth の帯域 → そのまま重心にする（S/R/C/I/T/F）
 * 5) fallback → NONE
 */
export function selectFrame(meta: FrameSelectorMeta, inputKind: InputKind): FrameKind {
  const descent = isDescentOn(meta.descentGate);
  const band = depthBand(meta.depth);

  // 1) 落下中は「崩れない器」を優先
  if (descent) {
    // 深度がS帯ならS固定、それ以外はMICROで安全に返す
    if (band === 'S') return 'S';
    return 'MICRO';
  }

  // 2) 入力が短い/挨拶は器を軽く
  if (inputKind === 'micro') return 'MICRO';
  if (inputKind === 'greeting') return 'NONE';

  // 3) 実務・デバッグはCreationの器
  if (inputKind === 'request' || inputKind === 'debug') return 'C';

  // 4) 深度帯域に追従（重心）
  if (band) return band;

  // 5) 何も分からないなら素で返す
  return 'NONE';
}
