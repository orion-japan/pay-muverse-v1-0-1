// src/lib/iros/mirrorEngine/resolveMirrorMode.ts
// 揺れ(Y)・余白(H)・深度・SelfAcceptance から
// 「どのミラーモードで応答するか」を決めるロジック。
// - いまはシンプルなルールベース
// - 将来、LLM判定に差し替える場合もこのモジュール内で完結させる想定

import type { Depth } from '../system';
import type { UnifiedLikeAnalysis } from '../unifiedAnalysis';
import type {
  HLevel,
  YLevel,
  MirrorMode,
  IrosTurnMeta,
} from '../types';

export type ResolveMirrorModeInput = {
  yLevel: YLevel;
  hLevel: HLevel;
  depth?: Depth | string | null;
  selfAcceptance?: number | null;
  unified?: UnifiedLikeAnalysis | null;
  prevMeta?: Partial<IrosTurnMeta> | null;
};

export type ResolveMirrorModeResult = {
  mirrorMode: MirrorMode;
};

/**
 * メイン入口
 * - Y/H + depth + SA からミラーモードを決定
 * - まずはルールベースだが、パラメータは Iros 側の感覚に合わせて調整可能
 */
export function resolveMirrorMode(
  input: ResolveMirrorModeInput,
): ResolveMirrorModeResult {
  const { yLevel, hLevel, depth, selfAcceptance, unified, prevMeta } = input;

  const sa = normalizeSA(
    selfAcceptance ?? unified?.selfAcceptance ?? null,
  );
  const d = depth ? String(depth) : null;

  let mode: MirrorMode = 'default';

  // 1) 強い揺れ ＋ 余白が狭い → まず「受け止め・保留」寄り
  if (yLevel >= 3 || (yLevel >= 2 && hLevel <= 1)) {
    mode = 'hold';
  }

  // 2) SA がかなり低い → まずは hold を優先
  if (sa != null && sa < 0.25) {
    mode = 'hold';
  }

  // 3) SA が中〜高 ＋ I層 / C層 ＋ 余白が十分 → 深いミラーを許容
  if (
    sa != null &&
    sa >= 0.5 &&
    d &&
    (d.startsWith('I') || d.startsWith('C')) &&
    hLevel >= 2 &&
    yLevel >= 1
  ) {
    mode = 'deep';
  }

  // 4) 「揺れは中くらい」「余白はそこそこ」「SA も中域」
  //    → 認知の整理・捉え直しを強める reframe
  if (
    mode === 'default' &&
    yLevel >= 1 &&
    yLevel <= 2 &&
    hLevel >= 1 &&
    sa != null &&
    sa >= 0.35 &&
    sa <= 0.7
  ) {
    mode = 'reframe';
  }

  // 5) 直前ターンのモードとの連続性
  mode = adjustWithPrev(mode, prevMeta);

  return { mirrorMode: mode };
}

/* ========= 内部ヘルパー ========= */

function normalizeSA(value: number | null | undefined): number | null {
  if (value == null || Number.isNaN(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 直前ターンの mirrorMode を見て、急激な変化を少し抑える
 */
function adjustWithPrev(
  current: MirrorMode,
  prevMeta?: Partial<IrosTurnMeta> | null,
): MirrorMode {
  if (!prevMeta) return current;
  const prev = prevMeta.mirrorMode as MirrorMode | null | undefined;
  if (!prev) return current;

  // 直前が deep で、今回も条件的には deep だが
  // Y/H がだいぶ落ち着いている場合は、一度 reframe に落とす
  if (
    prev === 'deep' &&
    current === 'deep' &&
    typeof prevMeta.yLevel === 'number' &&
    prevMeta.yLevel >= 2
  ) {
    // 深掘りが連続しすぎないように一歩手前にする
    return 'reframe';
  }

  // 直前が hold → 今回も揺れが強い場合は hold を維持
  if (prev === 'hold' && current === 'default') {
    return 'hold';
  }

  return current;
}
